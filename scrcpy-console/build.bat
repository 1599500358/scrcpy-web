@echo off
echo ========================================
echo   ScrcpyConsole 编译脚本
echo ========================================
echo.

REM 检查是否启用 WebRTC
set ENABLE_WEBRTC=0
if "%1"=="webrtc" set ENABLE_WEBRTC=1
if "%WEBRTC_ENABLED%"=="1" set ENABLE_WEBRTC=1

echo 编译模式: WebRTC=%ENABLE_WEBRTC%
echo.

REM 检查是否安装了编译器
where cl >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 MSVC 编译器
    echo 请运行 "Developer Command Prompt for VS" 或安装 Visual Studio
    pause
    exit /b 1
)

REM 设置编译选项
set SOURCES=scrcpy_console.c
set LIBS=ws2_32.lib ole32.lib oleaut32.lib windowscodecs.lib advapi32.lib crypt32.lib

if %ENABLE_WEBRTC%==1 (
    echo 启用 WebRTC 支持...
    echo.

    REM 检查 libdatachannel 库是否存在
    if not exist "libdatachannel\include\rtc\rtc.h" (
        echo 警告: 未找到 libdatachannel 库
        echo.
        echo 请下载预编译包:
        echo   https://github.com/paullouisageneau/libdatachannel/releases
        echo.
        echo 并解压到 libdatachannel 目录:
        echo   scrcpy-console\libdatachannel\include\rtc\rtc.h
        echo   scrcpy-console\libdatachannel\lib\datachannel.lib
        echo   scrcpy-console\libdatachannel\bin\datachannel.dll
        echo.
        echo 或者设置 WEBRTC_PATH 环境变量指向库目录
        echo.
        pause
        exit /b 1
    )

    set SOURCES=%SOURCES% webrtc_support.c local_video_relay.c
    set LIBS=%LIBS% datachannel.lib
    set DEFINES=/D USE_WEBRTC
    set INCLUDES=/I libdatachannel\include
    set LIB_PATHS=/LIBPATH:libdatachannel\lib

    echo WebRTC 库已找到，开始编译...
) else (
    echo 编译标准版本（无 WebRTC）...
)

REM 编译
echo.
echo 编译中...
if %ENABLE_WEBRTC%==1 (
    cl /Fe:scrcpy-console.exe %SOURCES% %LIBS% /O2 /W3 %DEFINES% %INCLUDES% %LIB_PATHS%
) else (
    cl /Fe:scrcpy-console.exe %SOURCES% %LIBS% /O2 /W3
)

if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo   编译成功!
    echo ========================================
    echo.
    echo 可执行文件: scrcpy-console.exe
    if %ENABLE_WEBRTC%==1 (
        echo WebRTC 支持: 已启用
        echo.
        echo 注意: 运行时需要 datachannel.dll 在同目录或 PATH 中
    )
    echo.
    echo 使用方法:
    echo   scrcpy-console.exe [服务器地址:端口]
    echo   例如: scrcpy-console.exe 192.168.1.100:8080
) else (
    echo.
    echo 编译失败!
)

echo.
pause
