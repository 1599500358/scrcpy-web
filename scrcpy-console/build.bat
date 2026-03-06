@echo off
echo 正在编译 ScrcpyConsole...

REM 检查是否安装了编译器
where cl >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 MSVC 编译器
    echo 请运行 "Developer Command Prompt for VS" 或安装 Visual Studio
    pause
    exit /b 1
)

REM 编译，添加WIC库支持
cl /Fe:scrcpy-console.exe scrcpy_console.c ws2_32.lib ole32.lib oleaut32.lib windowscodecs.lib /O2 /W3

if %errorlevel% equ 0 (
    echo.
    echo 编译成功! 可执行文件: scrcpy-console.exe
    echo.
    echo 使用方法:
    echo   scrcpy-console.exe [服务器地址:端口]
    echo   例如: scrcpy-console.exe 192.168.1.100:8080
) else (
    echo 编译失败!
)

pause