#!/bin/bash

# Scrcpy 远程控制系统启动脚本

echo "================================"
echo "Scrcpy 远程控制系统"
echo "================================"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装 Node.js"
    echo "下载地址: https://nodejs.org/"
    exit 1
fi

echo "Node.js 版本: $(node --version)"
echo ""

# 进入中继服务器目录
cd relay-server

# 检查是否已安装依赖
if [ ! -d "node_modules" ]; then
    echo "正在安装依赖..."
    npm install
    echo ""
fi

# 启动服务器
echo "正在启动中继服务器..."
echo "服务器端口: 8080"
echo "访问地址: http://localhost:8080"
echo ""
echo "按 Ctrl+C 停止服务器"
echo "================================"
echo ""

node server.js
