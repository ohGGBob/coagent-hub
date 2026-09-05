@echo off
title CoAgent Hub
cd /d "D:\CoAgent项目开发"
echo ================================================
echo   CoAgent Hub  starting...  (Ctrl+C to stop)
echo ================================================
node src\server.js
echo.
echo [Hub exited] Press any key to close...
pause >nul
