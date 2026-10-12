@echo off
chcp 65001 >nul
REM ============================================
REM  教师端智能体后端 - 一键启动（前后端分离）
REM  首次运行自动安装依赖；后端运行于 127.0.0.1:8767
REM  启动后回到教师端 Agent 模式即自动使用本后端
REM ============================================
cd /d "%~dp0"

REM 寻找可用的 Python 解释器
set "PY=python"
where python >nul 2>nul || set "PY=python3"
if exist "D:\Python\Python312\python.exe" set "PY=D:\Python\Python312\python.exe"
if exist "C:\Python312\python.exe" set "PY=C:\Python312\python.exe"
if exist "C:\Python310\python.exe" set "PY=C:\Python310\python.exe"

echo [1/2] 检查依赖（首次运行会自动安装，请耐心等待）...
"%PY%" -c "import fastapi, uvicorn, langgraph, openai" >nul 2>nul
if errorlevel 1 (
  echo   正在安装依赖，可能需要几分钟...
  "%PY%" -m pip install -r requirements.txt --quiet
  if errorlevel 1 (
    echo   [错误] 依赖安装失败，请检查网络或手动执行：
    echo   "%PY%" -m pip install -r requirements.txt
    pause
    exit /b 1
  )
)

echo [2/2] 启动智能体后端（http://127.0.0.1:8767）...
echo   关闭本窗口即停止后端；请保持窗口开启。
echo.
"%PY%" server.py
pause
