#!/bin/bash
# 使用 MinGW 交叉编译 Windows 控制台程序

set -e

echo "========================================"
echo "  编译 Scrcpy Console (Windows)"
echo "========================================"
echo ""

# 检查 MinGW 是否安装
if ! command -v x86_64-w64-mingw32-gcc &> /dev/null; then
    echo "错误: 未找到 MinGW-w64 编译器"
    echo "请安装: sudo apt install mingw-w64"
    exit 1
fi

echo "编译器版本:"
x86_64-w64-mingw32-gcc --version | head -n 1
echo ""

# 编译参数
CC="x86_64-w64-mingw32-gcc"
OUTPUT="scrcpy-console.exe"
SOURCE="scrcpy_console.c"
LIBS="-lws2_32 -lwindowscodecs -lole32 -loleaut32 -ladvapi32"
CFLAGS="-O2 -Wall -Wextra -D_WIN32_WINNT=0x0600"

echo "正在编译..."
echo "  源文件: $SOURCE"
echo "  输出: $OUTPUT"
echo ""

# 执行编译
$CC $CFLAGS -o $OUTPUT $SOURCE $LIBS

if [ $? -eq 0 ]; then
    echo ""
    echo "========================================"
    echo "  ✓ 编译成功!"
    echo "========================================"
    echo ""
    echo "可执行文件: $(pwd)/$OUTPUT"
    echo "文件大小: $(ls -lh $OUTPUT | awk '{print $5}')"
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
