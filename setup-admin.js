// setup-admin.js - Creates first admin user
// ⚠️ SECURITY: Change default credentials in production!

const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Same database path as server.js
const dbPath = path.join(process.env.APPDATA || process.env.USERPROFILE, 'TimesheetData', 'timesheet.db');
const db = new sqlite3.Database(dbPath);

// 🔐 Use environment variables for credentials (fallback to defaults for first-time setup)
const ADMIN = {
  user_id: process.env.ADMIN_USER_ID || 'admin1',
  password: process.env.ADMIN_PASSWORD || 'admin123', // ⚠️ CHANGE THIS IN PRODUCTION!
  name: process.env.ADMIN_NAME || 'Main Admin',
  role: 'admin'
};

// ⚠️ WARNING: This script is for INITIAL SETUP ONLY.
// After first login, change the admin password via the admin panel or database.
// NEVER use default credentials in production environments.

async function createAdmin() {
  console.log('🔧 Setting up admin user...');
  console.log(`   User ID: ${ADMIN.user_id}`);
  console.log(`   Name: ${ADMIN.name}`);
  console.log(`   ⚠️  Password: ${process.env.ADMIN_PASSWORD ? '[from env]' : '[DEFAULT - CHANGE ME!]'}`);
  
  try {
    const hash = await bcrypt.hash(ADMIN.password, 10);
    
    db.run(
      `INSERT INTO users (user_id, password_hash, name, role, hourly_rate) VALUES (?, ?, ?, ?, ?)`,
      [ADMIN.user_id, hash, ADMIN.name, ADMIN.role, 0], // Added hourly_rate to match schema
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE') || err.message.includes('already exists')) {
            console.log('⚠️  Admin user already exists! No changes made.');
          } else {
            console.error('❌ Database error:', err.message);
          }
        } else {
          console.log('\n✅ SUCCESS! Admin user created.');
          console.log('🔑 Login credentials:');
          console.log(`   User ID: ${ADMIN.user_id}`);
          console.log(`   Password: ${ADMIN.password}`);
          console.log('\n⚠️  IMPORTANT: Change the password after first login!');
        }
        db.close();
        process.exit(0);
      }
    );
  } catch (e) {
    console.error('❌ Failed to create admin:', e.message);
    db.close();
    process.exit(1);
  }
}

createAdmin();