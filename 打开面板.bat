@echo off
rem godot-mcp-enhanced Web GUI launcher (double-click me).
rem - Running server found: opens the browser WITH credentials (one-time auth;
rem   after that, the Chinese-named entry html in this folder opens the panel directly).
rem - No server running: opens the local portal page (auto-redirects once a server starts).
rem - Multiple servers: a numbered menu appears in this window, type a number + Enter.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Install Node.js first.
  pause
  exit /b 1
)
if not exist "build\index.js" (
  echo [ERROR] build\index.js missing. Run: npm run build
  pause
  exit /b 1
)
node build\index.js dashboard --web
if errorlevel 1 pause
