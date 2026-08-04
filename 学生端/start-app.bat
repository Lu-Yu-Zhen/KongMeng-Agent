@echo off
chcp 65001 >nul 2>&1
title KongMeng-Student - Start

set "TARGET=%~dp0dist\win-unpacked\"

if not exist "%TARGET%KongMeng-Student.exe" (
    echo [Error] exe not found, please run rebuild.bat first
    pause
    exit /b 1
)

start "" "%TARGET%KongMeng-Student.exe"
