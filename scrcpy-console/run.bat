@echo off
chcp 65001 >nul
title Scrcpy Console Client

REM 检查是否已编译
if not exist "scrcpy-console.exe" (
    echo 错误: 未找到 scrcpy-console.exe
    echo 请先运行 build.bat 编译程序
    pause
    exit /b 1
)

echo ========================================
echo   Scrcpy Console Client
echo ========================================
echo.
echo 请输入中继服务器地址 (默认: localhost:8080):
set /p SERVER_URL=

if "%SERVER_URL%"=="" (
    set SERVER_URL=localhost:8080
)

echo.
echo 正在连接到服务器: %SERVER_URL%
echo.

scrcpy-console.exe %SERVER_URL%

pause
