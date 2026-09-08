@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 株式会社MANEXION 稟議システムを起動します (停止: Ctrl+C)
node server.js
pause
