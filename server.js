const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-fallback-key';
const SALT_ROUNDS = 10;

// 🛠️ Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 🗄️ Database Setup
const dbPath = path.join(process.env.APPDATA || process.env.USERPROFILE, 'TimesheetData', 'timesheet.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ DB Connection Error:', err);
  else console.log('✅ Connected to SQLite database:', dbPath);
});

db.serialize(() => {
  db.run(`ALTER TABLE users ADD COLUMN hourly_rate REAL DEFAULT 0`, () => {});
  
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    person_number TEXT,
    role TEXT DEFAULT 'worker' CHECK(role IN ('worker', 'admin')),
    hourly_rate REAL DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    start_time INTEGER,
    end_time INTEGER,
    pause_start_time INTEGER,
    total_pause_seconds INTEGER DEFAULT 0,
    status TEXT DEFAULT 'inactive' CHECK(status IN ('inactive', 'active', 'paused', 'completed')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS monthly_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    adjusted_work_seconds INTEGER DEFAULT 0,
    adjusted_pause_seconds INTEGER DEFAULT 0,
    notes TEXT,
    UNIQUE(worker_id, year, month),
    FOREIGN KEY(worker_id) REFERENCES users(id)
  )`);
});

// ⏱️ Helper: Format seconds to HH:MM:SS
function formatSeconds(totalSeconds) {
  if (!totalSeconds || totalSeconds < 0) return '00:00:00';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// 🔐 Authentication Middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied: No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('Token verification error:', err.message);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// 🔐 Role Authorization Middleware
const requireRole = (role) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== role) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
};

// ================= 📝 ROUTES =================

// 1. 👤 Login
app.post('/api/login', (req, res) => {
  const { user_id, password } = req.body;
  if (!user_id || !password) return res.status(400).json({ error: 'User ID and password are required' });

  db.get('SELECT * FROM users WHERE user_id = ?', [user_id], async (err, user) => {
    if (err) { console.error('Login DB error:', err); return res.status(500).json({ error: 'Database error' }); }
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    try {
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid credentials' });

      const token = jwt.sign(
        { id: user.id, user_id: user.user_id, role: user.role },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      res.json({ token, role: user.role, name: user.name });
    } catch (e) { res.status(500).json({ error: 'Authentication error' }); }
  });
});

// 2. ⏱️ Time Tracking Routes
app.get('/api/time/current', authenticate, (req, res) => {
  db.get('SELECT * FROM sessions WHERE user_id = ? AND status IN (?, ?)', [req.user.id, 'active', 'paused'], (err, session) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(session || null);
  });
});

app.post('/api/time/start', authenticate, (req, res) => {
  db.get('SELECT status FROM sessions WHERE user_id = ? AND status IN (?, ?)', [req.user.id, 'active', 'paused'], (err, existing) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (existing) return res.status(400).json({ error: 'Session already active' });
    db.run('INSERT INTO sessions (user_id, start_time, status) VALUES (?, ?, ?)', [req.user.id, Date.now(), 'active'], function (err) {
      if (err) return res.status(500).json({ error: 'Failed to start session' });
      res.json({ id: this.lastID, status: 'active', start_time: Date.now() });
    });
  });
});

app.post('/api/time/pause', authenticate, (req, res) => {
  db.get('SELECT * FROM sessions WHERE user_id = ? AND status = ?', [req.user.id, 'active'], (err, session) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!session) return res.status(400).json({ error: 'No active session to pause' });
    db.run('UPDATE sessions SET status = ?, pause_start_time = ? WHERE id = ?', ['paused', Date.now(), session.id], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to pause' });
      res.json({ status: 'paused', pause_start_time: Date.now() });
    });
  });
});

app.post('/api/time/resume', authenticate, (req, res) => {
  db.get('SELECT * FROM sessions WHERE user_id = ? AND status = ?', [req.user.id, 'paused'], (err, session) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!session) return res.status(400).json({ error: 'No paused session to resume' });
    const pauseDuration = Math.floor((Date.now() - session.pause_start_time) / 1000);
    db.run('UPDATE sessions SET status = ?, total_pause_seconds = total_pause_seconds + ?, pause_start_time = NULL WHERE id = ?', ['active', pauseDuration, session.id], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to resume' });
      res.json({ status: 'active', added_pause_seconds: pauseDuration });
    });
  });
});

app.post('/api/time/end', authenticate, (req, res) => {
  db.get('SELECT * FROM sessions WHERE user_id = ? AND status IN (?, ?)', [req.user.id, 'active', 'paused'], (err, session) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!session) return res.status(400).json({ error: 'No active session to end' });
    let finalPause = session.total_pause_seconds || 0;
    if (session.status === 'paused' && session.pause_start_time) {
      finalPause += Math.floor((Date.now() - session.pause_start_time) / 1000);
    }
    const totalSeconds = Math.floor((Date.now() - session.start_time) / 1000);
    const workTime = totalSeconds - finalPause;
    db.run('UPDATE sessions SET status = ?, end_time = ?, total_pause_seconds = ? WHERE id = ?', ['completed', Date.now(), finalPause, session.id], (err) => {
      if (err) return res.status(500).json({ error: 'Failed to end session' });
      res.json({ message: 'Session completed', work_time_seconds: workTime, pause_time_seconds: finalPause });
    });
  });
});

// 3. 👨‍💼 Admin: Worker CRUD
app.get('/api/workers', authenticate, requireRole('admin'), (req, res) => {
  db.all('SELECT id, user_id, name, person_number, role, hourly_rate FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

app.post('/api/workers', authenticate, requireRole('admin'), async (req, res) => {
  const { user_id, password, name, person_number, role, hourly_rate } = req.body;
  if (!user_id || !password || !name) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    db.run('INSERT INTO users (user_id, password_hash, name, person_number, role, hourly_rate) VALUES (?, ?, ?, ?, ?, ?)', 
      [user_id, hash, name, person_number || null, role || 'worker', parseFloat(hourly_rate) || 0], 
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint')) return res.status(400).json({ error: 'User ID already exists' });
          return res.status(500).json({ error: 'Database error' });
        }
        res.status(201).json({ id: this.lastID, message: 'User created successfully' });
      }
    );
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/workers/:id', authenticate, requireRole('admin'), async (req, res) => {
  const workerId = parseInt(req.params.id);
  if (isNaN(workerId)) return res.status(400).json({ error: 'Invalid worker ID' });
  
  const { name, user_id, password, person_number, role, hourly_rate } = req.body;
  if (!name || !user_id) return res.status(400).json({ error: 'Name and User ID are required' });

  try {
    db.get('SELECT id FROM users WHERE user_id = ? AND id != ?', [user_id, workerId], async (err, existing) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (existing) return res.status(400).json({ error: 'User ID already taken' });

      let query = 'UPDATE users SET name = ?, user_id = ?, person_number = ?, role = ?, hourly_rate = ?';
      let params = [name, user_id, person_number || null, role || 'worker', parseFloat(hourly_rate) || 0];

      if (password && password.trim() !== '') {
        try {
          const hash = await bcrypt.hash(password, SALT_ROUNDS);
          query += ', password_hash = ?';
          params.push(hash);
        } catch (hashErr) { return res.status(500).json({ error: 'Failed to process password' }); }
      }

      query += ' WHERE id = ?';
      params.push(workerId);

      db.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: 'Database update failed: ' + err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Worker not found' });
        res.json({ message: 'Worker updated successfully' });
      });
    });
  } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.delete('/api/workers/:id', authenticate, requireRole('admin'), (req, res) => {
  db.run('DELETE FROM users WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (this.changes === 0) return res.status(404).json({ error: 'Worker not found' });
    res.json({ message: 'Worker deleted successfully' });
  });
});

// 4. 📊 Admin: Time Reports with Details
app.get('/api/reports/time-details', authenticate, requireRole('admin'), (req, res) => {
  const { month, year, worker_id } = req.query;
  
  let dateFilter = '';
  let params = [];
  
  if (month && year) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    endDate.setHours(23, 59, 59, 999);
    dateFilter = 'AND s.start_time >= ? AND s.start_time <= ?';
    params.push(startDate.getTime(), endDate.getTime());
  }
  
  let workerFilter = '';
  if (worker_id) {
    workerFilter = 'AND u.id = ?';
    params.push(parseInt(worker_id));
  }
  
  const query = `
    SELECT 
      s.id, s.start_time, s.end_time, s.total_pause_seconds, s.status,
      u.id as worker_id, u.name as worker_name, u.user_id as worker_user_id,
      CASE WHEN s.status = 'completed' THEN
        (CAST((s.end_time - s.start_time) AS REAL) / 1000) - s.total_pause_seconds
      ELSE 0 END as work_seconds
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE u.role = 'worker' ${dateFilter} ${workerFilter}
    ORDER BY s.start_time DESC
  `;
  
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    
    const sessions = rows.map(row => ({
      id: row.id,
      worker_id: row.worker_id,
      worker_name: row.worker_name,
      worker_user_id: row.worker_user_id,
      start_time: row.start_time,
      end_time: row.end_time,
      status: row.status,
      start_date: row.start_time ? new Date(row.start_time).toLocaleDateString() : '',
      start_time_formatted: row.start_time ? new Date(row.start_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '',
      end_time_formatted: row.end_time ? new Date(row.end_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '',
      work_seconds: Math.floor(row.work_seconds),
      pause_seconds: Math.floor(row.total_pause_seconds),
      work_time: formatSeconds(row.work_seconds),
      pause_time: formatSeconds(row.total_pause_seconds),
      total_time: formatSeconds(row.end_time && row.start_time ? Math.floor((row.end_time - row.start_time) / 1000) : 0)
    }));
    
    res.json(sessions);
  });
});

// ✅ Update Session Time (Admin Edit)
app.put('/api/reports/sessions/:id', authenticate, requireRole('admin'), (req, res) => {
  const sessionId = parseInt(req.params.id);
  const { start_time, end_time, pause_seconds } = req.body;
  
  if (!start_time || !end_time) return res.status(400).json({ error: 'Start time and end time are required' });
  
  const startTs = new Date(start_time).getTime();
  const endTs = new Date(end_time).getTime();
  
  if (endTs <= startTs) return res.status(400).json({ error: 'End time must be after start time' });
  
  const totalDuration = Math.floor((endTs - startTs) / 1000);
  const pauseSec = parseInt(pause_seconds) || 0;
  const workSec = totalDuration - pauseSec;
  
  if (workSec < 0) return res.status(400).json({ error: 'Pause time cannot be greater than total duration' });
  
  db.run(
    'UPDATE sessions SET start_time = ?, end_time = ?, total_pause_seconds = ?, status = ? WHERE id = ?',
    [startTs, endTs, pauseSec, 'completed', sessionId],
    function(err) {
      if (err) return res.status(500).json({ error: 'Database update failed: ' + err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Session not found' });
      res.json({ message: 'Session updated successfully', work_seconds: workSec, pause_seconds: pauseSec });
    }
  );
});

// 5. 📊 Admin: Monthly Summary with Salary Calculation (COMPLETELY REWRITTEN WITH DEBUG)
app.get('/api/reports/monthly', authenticate, requireRole('admin'), (req, res) => {
  const { month, year } = req.query;
  
  console.log('\n========== MONTHLY REPORT DEBUG ==========');
  console.log(`📅 Request: month=${month}, year=${year}`);
  
  if (!month || !year) {
    console.log('❌ Error: Month and year are required');
    return res.status(400).json({ error: 'Month and year are required' });
  }
  
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  endDate.setHours(23, 59, 59, 999);
  
  console.log(`📅 Date Range:`);
  console.log(`   Start: ${startDate.toISOString()} (${startDate.toLocaleString()})`);
  console.log(`   End: ${endDate.toISOString()} (${endDate.toLocaleString()})`);
  console.log(`   Start Timestamp: ${startDate.getTime()}`);
  console.log(`   End Timestamp: ${endDate.getTime()}`);
  
  // First, let's check ALL sessions in the database
  console.log('\n🔍 Checking ALL sessions in database...');
  db.all('SELECT id, user_id, start_time, end_time, status FROM sessions WHERE status = "completed"', [], (err, allSessions) => {
    if (err) {
      console.error('❌ Error querying sessions:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    console.log(`   Found ${allSessions.length} completed sessions total`);
    allSessions.forEach(s => {
      const sDate = new Date(s.start_time);
      console.log(`   - Session #${s.id}: User ${s.user_id}, Date: ${sDate.toLocaleDateString()}, Start: ${sDate.toLocaleString()}`);
    });
    
    // Now run the monthly query
    console.log('\n🔍 Running monthly aggregation query...');
    const query = `
      SELECT 
        u.id as db_user_id, 
        u.user_id, 
        u.name, 
        u.person_number, 
        u.hourly_rate,
        COALESCE(SUM(CASE WHEN s.status = 'completed' THEN 
          (CAST((s.end_time - s.start_time) AS REAL)/1000) - s.total_pause_seconds ELSE 0 END), 0) as calc_work_sec,
        COALESCE(SUM(s.total_pause_seconds), 0) as calc_pause_sec,
        COUNT(CASE WHEN s.status = 'completed' THEN 1 END) as completed_sessions
      FROM users u
      LEFT JOIN sessions s ON u.id = s.user_id 
        AND s.status = 'completed' 
        AND s.start_time >= ? 
        AND s.start_time <= ?
      WHERE u.role = 'worker'
      GROUP BY u.id
      ORDER BY u.name
    `;
    
    console.log('📝 Query parameters:', [startDate.getTime(), endDate.getTime()]);
    
    db.all(query, [startDate.getTime(), endDate.getTime()], (err, rows) => {
      if (err) {
        console.error('❌ Monthly query error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      console.log(`\n📊 Found ${rows.length} workers`);
      
      rows.forEach(row => {
        console.log(`\n   Worker: ${row.name} (ID: ${row.db_user_id})`);
        console.log(`     Sessions: ${row.completed_sessions}`);
        console.log(`     Work Seconds: ${Math.floor(row.calc_work_sec)}`);
        console.log(`     Work Time: ${formatSeconds(Math.floor(row.calc_work_sec))}`);
        console.log(`     Hourly Rate: $${row.hourly_rate}`);
        
        const rate = parseFloat(row.hourly_rate) || 0;
        const hoursWorked = Math.floor(row.calc_work_sec) / 3600;
        const earnings = hoursWorked * rate;
        
        console.log(`     Hours Worked: ${hoursWorked.toFixed(3)}`);
        console.log(`     Calculated Salary: $${earnings.toFixed(2)}`);
      });
      
      // Get adjustments
      db.all(`SELECT * FROM monthly_adjustments WHERE year=? AND month=?`, [year, month], (err2, adjustments) => {
        if (err2) {
          console.error('❌ Adjustments query error:', err2);
          return res.status(500).json({ error: 'Database error' });
        }
        
        console.log(`\n💰 Found ${adjustments.length} adjustments`);
        
        const adjMap = {};
        adjustments.forEach(a => { 
          adjMap[a.worker_id] = a;
          console.log(`   - Worker ${a.worker_id}: ${a.adjusted_work_seconds}s work, ${a.adjusted_pause_seconds}s pause`);
        });
        
        // Build result
        const result = rows.map(row => {
          const adj = adjMap[row.db_user_id] || {};
          const rate = parseFloat(row.hourly_rate) || 0;
          
          const finalWorkSec = adj.adjusted_work_seconds !== undefined 
            ? adj.adjusted_work_seconds 
            : Math.floor(row.calc_work_sec || 0);
          const finalPauseSec = adj.adjusted_pause_seconds !== undefined 
            ? adj.adjusted_pause_seconds 
            : Math.floor(row.calc_pause_sec || 0);
          
          const hoursWorked = finalWorkSec / 3600;
          const totalEarnings = hoursWorked * rate;
          
          return {
            db_user_id: row.db_user_id,
            user_id: row.user_id,
            name: row.name,
            person_number: row.person_number,
            hourly_rate: rate,
            work_time: formatSeconds(finalWorkSec),
            pause_time: formatSeconds(finalPauseSec),
            raw_work_seconds: finalWorkSec,
            raw_pause_seconds: finalPauseSec,
            total_earnings: totalEarnings.toFixed(2)
          };
        });
        
        console.log('\n✅ Final Result:');
        result.forEach(r => {
          console.log(`   ${r.name}: Work=${r.work_time}, Rate=$${r.hourly_rate}, Salary=$${r.total_earnings}`);
        });
        
        console.log('\n==========================================\n');
        
        res.json(result);
      });
    });
  });
});

// ✅ Save Monthly Adjustments
app.post('/api/reports/monthly/adjust', authenticate, requireRole('admin'), (req, res) => {
  const { month, year, adjustments } = req.body;
  if (!month || !year || !Array.isArray(adjustments)) return res.status(400).json({ error: 'Invalid data format' });
  
  const promises = adjustments.map(adj => {
    return new Promise((resolve, reject) => {
      db.run(`INSERT OR REPLACE INTO monthly_adjustments 
              (worker_id, year, month, adjusted_work_seconds, adjusted_pause_seconds, notes) 
              VALUES (?, ?, ?, ?, ?, ?)`,
        [adj.worker_id, year, month, adj.work_seconds, adj.pause_seconds, adj.notes || ''],
        function(err) { if(err) reject(err); else resolve(); }
      );
    });
  });
  
  Promise.all(promises)
    .then(() => res.json({ message: 'Adjustments saved successfully' }))
    .catch(err => {
      console.error('Save adjustments error:', err);
      res.status(500).json({ error: err.message });
    });
});

// 6. ⏱️ Worker: Get Session History
app.get('/api/time/history', authenticate, (req, res) => {
  const { month, year } = req.query;
  let dateFilter = '';
  let params = [req.user.id];

  if (month && year) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    endDate.setHours(23, 59, 59, 999);
    dateFilter = 'AND s.start_time >= ? AND s.start_time <= ?';
    params.push(startDate.getTime(), endDate.getTime());
  }

  const query = `
    SELECT s.id, s.start_time, s.end_time, s.total_pause_seconds, s.status,
    CASE WHEN s.status = 'completed' THEN (CAST((s.end_time - s.start_time) AS REAL) / 1000) - s.total_pause_seconds ELSE 0 END as work_seconds
    FROM sessions s WHERE s.user_id = ? ${dateFilter} ORDER BY s.start_time DESC
  `;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const sessions = rows.map(row => ({
      id: row.id,
      start_time: row.start_time,
      end_time: row.end_time,
      status: row.status,
      work_seconds: Math.floor(row.work_seconds),
      pause_seconds: Math.floor(row.total_pause_seconds),
      work_time: formatSeconds(row.work_seconds),
      pause_time: formatSeconds(row.total_pause_seconds),
      start_hour: row.start_time ? new Date(row.start_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '-',
      end_hour: row.end_time ? new Date(row.end_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '-'
    }));
    res.json(sessions);
  });
});

// ✅ MONTHLY SUMMARY: Worker - Get own monthly totals
app.get('/api/time/monthly', authenticate, (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ error: 'Month and year are required' });
  
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  endDate.setHours(23, 59, 59, 999);
  
  const query = `
    SELECT 
      COUNT(id) as total_sessions,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN
        (CAST((end_time - start_time) AS REAL) / 1000) - total_pause_seconds ELSE 0 END), 0) as total_work_seconds,
      COALESCE(SUM(total_pause_seconds), 0) as total_pause_seconds
    FROM sessions
    WHERE user_id = ? AND status = 'completed' AND start_time >= ? AND start_time <= ?
  `;
  
  db.get(query, [req.user.id, startDate.getTime(), endDate.getTime()], (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const totalWork = Math.floor(row.total_work_seconds || 0);
    const totalPause = Math.floor(row.total_pause_seconds || 0);
    res.json({
      total_sessions: row.total_sessions || 0,
      total_work_seconds: totalWork,
      total_pause_seconds: totalPause,
      work_time: formatSeconds(totalWork),
      pause_time: formatSeconds(totalPause),
      work_hours: (totalWork / 3600).toFixed(2)
    });
  });
});

// 🚀 Start Server
app.listen(PORT, () => {
  console.log(`\n✅ Server running on http://localhost:${PORT}`);
  console.log(`📁 Database: ${dbPath}\n`);
});