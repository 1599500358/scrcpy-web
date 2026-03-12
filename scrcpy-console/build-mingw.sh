#!/bin/bash
# 使用 MinGW 交叉编译 Windows 控制台程序
# 支持 Linux 和 macOS

set -e

echo "========================================"
echo "  编译 Scrcpy Console (Windows)"
echo "========================================"
echo ""

# 检测操作系统
OS="$(uname -s)"
echo "运行平台: $OS"

# 检查 WebRTC 开关
ENABLE_WEBRTC=0
if [ "$1" = "webrtc" ] || [ "$WEBRTC_ENABLED" = "1" ]; then
    ENABLE_WEBRTC=1
fi

echo "编译模式: WebRTC=$ENABLE_WEBRTC"
echo ""

# 根据操作系统选择编译器
if [ "$OS" = "Darwin" ]; then
    # macOS
    if ! command -v x86_64-w64-mingw32-gcc &> /dev/null; then
        echo "错误: 未找到 MinGW-w64 编译器"
        echo "请安装: brew install mingw-w64"
        exit 1
    fi
    CC="x86_64-w64-mingw32-gcc"
elif [ "$OS" = "Linux" ]; then
    # Linux
    if ! command -v x86_64-w64-mingw32-gcc &> /dev/null; then
        echo "错误: 未找到 MinGW-w64 编译器"
        echo "请安装: sudo apt install mingw-w64"
        exit 1
    fi
    CC="x86_64-w64-mingw32-gcc"
else
    echo "错误: 不支持的操作系统 $OS"
    echo "此脚本仅支持 Linux 和 macOS 交叉编译 Windows 程序"
    echo "Windows 用户请使用 build.bat"
    exit 1
fi

echo "编译器版本:"
$CC --version | head -n 1
echo ""

# 编译参数
OUTPUT="scrcpy-console.exe"
SOURCES="scrcpy_console.c"
LIBS="-lws2_32 -lwindowscodecs -lole32 -loleaut32 -ladvapi32"
CFLAGS="-O2 -Wall -Wextra -D_WIN32_WINNT=0x0600"

# WebRTC 支持
if [ $ENABLE_WEBRTC -eq 1 ]; then
    echo "启用 WebRTC 支持..."
    echo ""

    # 检查 libdatachannel 库
    if [ ! -f "libdatachannel/include/rtc/rtc.h" ]; then
        echo "警告: 未找到 libdatachannel 库"
        echo ""
        echo "请下载预编译包:"
        echo "  https://github.com/paullouisageneau/libdatachannel/releases"
        echo ""
        echo "并解压到 libdatachannel 目录:"
        echo "  scrcpy-console/libdatachannel/include/rtc/rtc.h"
        echo "  scrcpy-console/libdatachannel/lib/libdatachannel.a"
        echo ""
        exit 1
    fi

    SOURCES="$SOURCES webrtc_support.c"
    LIBS="$LIBS -Llibdatachannel/lib -ldatachannel -lssl -lcrypto -lz"
    CFLAGS="$CFLAGS -DUSE_WEBRTC -Ilibdatachannel/include"

    echo "WebRTC 库已找到，开始编译..."
else
    echo "编译标准版本（无 WebRTC）..."
fi

echo "正在编译..."
echo "  源文件: $SOURCES"
echo "  输出: $OUTPUT"
echo ""

# 执行编译
$CC $CFLAGS -o $OUTPUT $SOURCES $LIBS

if [ $? -eq 0 ]; then
    echo ""
    echo "========================================"
    echo "  ✓ 编译成功!"
    echo "========================================"
    echo ""
    echo "可执行文件: $(pwd)/$OUTPUT"
    echo "文件大小: $(ls -lh $OUTPUT | awk '{print $5}')"
    if [ $ENABLE_WEBRTC -eq 1 ]; then
        echo ""
        echo "WebRTC 支持: 已启用"
        echo "注意: 运行时需要 libdatachannel.dll 在同目录"
    fi
    echo ""
    echo "使用方法:"
    echo "  在 Windows 中运行:"
    echo "    $OUTPUT [服务器地址:端口]"
    echo "    例如: $OUTPUT 192.168.1.100:8080"
    echo ""
else
    echo ""
    echo "编译失败!"
    exit 1
fi