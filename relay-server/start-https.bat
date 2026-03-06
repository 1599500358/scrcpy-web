@echo off
echo ========================================
echo   启动双模式中继服务器 (HTTP + HTTPS)
echo ========================================
echo.

REM 检查证书是否存在
if not exist "cert\server.crt" (
    echo [错误] SSL 证书不存在！
    echo.
    echo 请先运行: node generate-cert.js
    echo.
    pause
    exit /b 1
)

echo [提示] 启用双模式...
echo   - HTTP 端口: 8080 (scrcpy 使用)
echo   - HTTPS 端口: 8443 (Web 访问)
echo.

set ENABLE_HTTPS=true
set HTTP_PORT=8080
set HTTPS_PORT=8443
node server.js
