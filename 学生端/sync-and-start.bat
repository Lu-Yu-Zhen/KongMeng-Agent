@echo off
chcp 65001 >nul 2>&1
title KongMeng-Student - Sync and Start

echo ============================================
echo   KongMeng-Student - Sync and Start
echo ============================================
echo.

set "SOURCE=%~dp0"
set "TARGET=%~dp0dist\win-unpacked\"

echo [1/3] Checking build directory...
if not exist "%TARGET%KongMeng-Student.exe" (
    echo [Error] exe not found, please run rebuild.bat first
    pause
    exit /b 1
)

echo [2/3] Syncing HTML and assets...
copy /Y "%SOURCE%index.html" "%TARGET%index.html" >nul 2>&1
copy /Y "%SOURCE%logo.png" "%TARGET%logo.png" >nul 2>&1
echo     - HTML file synced
echo     - Logo file synced

echo [3/3] Starting app...
start "" "%TARGET%KongMeng-Student.exe"
echo.
echo App started!
timeout /t 3 >nul
