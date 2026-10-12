@echo off
chcp 65001 >nul 2>&1
title KongMeng-Student - Rebuild

echo ============================================
echo   KongMeng-Student - Rebuild Desktop App
echo ============================================
echo.

set "SOURCE=%~dp0"

echo [1/2] Building (may take a few minutes)...
cd /d "%SOURCE%"
call npx electron-builder --win dir
if %errorlevel% neq 0 (
    echo.
    echo [Error] Build failed, please check error messages
    pause
    exit /b 1
)

echo.
echo [2/2] Build complete!
echo   Output: %SOURCE%dist\win-unpacked\
echo   Executable: %SOURCE%dist\win-unpacked\KongMeng-Student.exe
echo.
pause
