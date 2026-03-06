@echo off
chcp 65001 >nul
title Scrcpy 远程控制系统

echo ================================
echo Scrcpy 远程控制系统
echo ================================
echo.

REM 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 Node.js，请先安装 Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js 版本:
node --version
echo.

REM 进入中继服务器目录
cd relay-server

REM 检查是否已安装依赖
if not exist "node_modules" (
    echo 正在安装依赖...
    call npm install
    echo.
)

REM 启动服务器
echo 正在启动中继服务器...
echo 服务器端口: 8080
echo 访问地址: http://localhost:8080
echo.
echo 按 Ctrl+C 停止服务器
echo ================================
echo.

node server.js
pause
