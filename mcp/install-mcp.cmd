@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 18+ first: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0install-mcp.cjs" %*
if errorlevel 1 pause
