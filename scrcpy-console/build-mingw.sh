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
    CXX="x86_64-w64-mingw32-g++"
elif [ "$OS" = "Linux" ]; then
    # Linux
    if ! command -v x86_64-w64-mingw32-gcc &> /dev/null; then
        echo "错误: 未找到 MinGW-w64 编译器"
        echo "请安装: sudo apt install mingw-w64"
        exit 1
    fi
    CC="x86_64-w64-mingw32-gcc"
    CXX="x86_64-w64-mingw32-g++"
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
LINKER="$CC"  # 默认使用 CC 进行链接

# WebRTC 支持
if [ $ENABLE_WEBRTC -eq 1 ]; then
    echo "启用 WebRTC 支持..."
    echo ""

    # 优先使用 vcpkg 安装的库
    VCPKG_ROOT="$HOME/vcpkg"
    VCPKG_INSTALLED="$VCPKG_ROOT/installed/x64-mingw-static"

    if [ -f "$VCPKG_INSTALLED/include/rtc/rtc.h" ]; then
        echo "使用 vcpkg 安装的 libdatachannel..."
        SOURCES="$SOURCES webrtc_support.c"
        LIBS="$LIBS -L$VCPKG_INSTALLED/lib -ldatachannel -ljuice -lusrsctp -lssl -lcrypto -lws2_32 -liphlpapi -lcrypt32 -lsecur32 -lbcrypt -lstdc++"
        CFLAGS="$CFLAGS -DUSE_WEBRTC -I$VCPKG_INSTALLED/include"
        # 使用 g++ 进行链接以支持 C++ 标准库
        LINKER="$CXX"
        echo "WebRTC 库已找到，开始编译..."
    elif [ -f "libdatachannel/include/rtc/rtc.h" ]; then
        echo "使用本地 libdatachannel..."
        SOURCES="$SOURCES webrtc_support.c"
        LIBS="$LIBS -Llibdatachannel/lib -ldatachannel -lssl -lcrypto -lz"
        CFLAGS="$CFLAGS -DUSE_WEBRTC -Ilibdatachannel/include"
        echo "WebRTC 库已找到，开始编译..."
    else
        echo "错误: 未找到 libdatachannel 库"
        echo ""
        echo "请使用 vcpkg 安装:"
        echo "  vcpkg install libdatachannel:x64-mingw-static"
        echo ""
        echo "或下载预编译包到 libdatachannel 目录"
        exit 1
    fi
else
    echo "编译标准版本（无 WebRTC）..."
fi

echo "正在编译..."
echo "  源文件: $SOURCES"
echo "  输出: $OUTPUT"
echo ""

# 执行编译
if [ $ENABLE_WEBRTC -eq 1 ]; then
    # WebRTC 模式：先编译 C 代码为对象文件，再用 g++ 链接
    echo "编译对象文件..."
    for src in $SOURCES; do
        obj="${src%.c}.o"
        echo "  $src -> $obj"
        $CC $CFLAGS -c -o $obj $src
    done

    # 获取所有对象文件
    OBJECTS=""
    for src in $SOURCES; do
        obj="${src%.c}.o"
        OBJECTS="$OBJECTS $obj"
    done

    echo "链接..."
    $CXX -o $OUTPUT $OBJECTS $LIBS

    # 清理对象文件
    rm -f *.o
else
    # 标准模式：直接编译
    $LINKER $CFLAGS -o $OUTPUT $SOURCES $LIBS
fi

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