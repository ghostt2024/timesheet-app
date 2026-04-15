@echo off
title Timesheet App Manager
echo ========================================
echo   Timesheet App - Start Manager
echo ========================================
echo.

:: Check if running as Administrator
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [✓] Running as Administrator
    set ADMIN_MODE=1
) else (
    echo [⚠] Not running as Administrator - PM2 may have permission issues
    set ADMIN_MODE=0
)

:: 1. Check if PM2 is installed
where pm2 >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [1/4] PM2 not found. Installing globally...
    npm install -g pm2
    if %ERRORLEVEL% NEQ 0 (
        echo ❌ Failed to install PM2.
        goto RUN_DIRECT
    )
) else (
    echo [1/4] PM2 is already installed.
)

:: 2. Change to project directory
cd /d "C:\Users\Demo\Desktop\test"
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Failed to change directory.
    pause
    exit /b 1
)

:: 3. Try to start with PM2
echo [2/4] Attempting to start with PM2...
pm2 start server.js --name "timesheet" 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [✓] PM2 started successfully!
    echo [3/4] Saving PM2 state...
    pm2 save 2>nul
    echo [4/4] Done!
    echo.
    echo ✅ Timesheet App is running via PM2!
    echo 🌐 Open: http://localhost:3000
    echo.
    if "%ADMIN_MODE%"=="0" (
        echo ⚠️ If you see EPERM errors, run this script as Administrator.
    )
    echo.
    echo Press any key to exit...
    pause >nul
    exit /b 0
) else (
    echo [⚠] PM2 failed to start (permission issue?).
    goto RUN_DIRECT
)

:RUN_DIRECT
echo.
echo [Fallback] Starting app directly without PM2...
echo [✓] This will run in this window. Keep it open!
echo.
echo Starting server...
node server.js

:: If node fails
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Server crashed with error code %ERRORLEVEL%
    echo Press any key to exit...
    pause >nul
    exit /b %ERRORLEVEL%
)