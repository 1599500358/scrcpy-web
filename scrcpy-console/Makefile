# Makefile for Scrcpy Console Client

# 检测系统类型
ifeq ($(OS),Windows_NT)
    # Windows 原生编译
    CC = cl
    CFLAGS = /O2 /W3
    LDFLAGS = ws2_32.lib
    OUTPUT = scrcpy-console.exe
    RM = del /Q
else
    # Linux 交叉编译到 Windows
    CC = x86_64-w64-mingw32-gcc
    CFLAGS = -O2 -Wall -Wextra -D_WIN32_WINNT=0x0600
    LDFLAGS = -lws2_32
    OUTPUT = scrcpy-console.exe
    RM = rm -f
endif

SOURCE = scrcpy_console.c

.PHONY: all clean help

all: $(OUTPUT)

$(OUTPUT): $(SOURCE)
	@echo "========================================"
	@echo "  编译 Scrcpy Console Client"
	@echo "========================================"
	@echo ""
ifeq ($(OS),Windows_NT)
	@echo "使用 MSVC 编译..."
	$(CC) /Fe:$(OUTPUT) $(SOURCE) $(LDFLAGS) $(CFLAGS)
else
	@echo "使用 MinGW 交叉编译..."
	$(CC) $(CFLAGS) -o $(OUTPUT) $(SOURCE) $(LDFLAGS)
endif
	@echo ""
	@echo "编译完成: $(OUTPUT)"
	@echo ""

clean:
	@echo "清理编译文件..."
	$(RM) $(OUTPUT) *.obj 2>/dev/null || true
	@echo "清理完成"

help:
	@echo "Scrcpy Console Client 编译帮助"
	@echo ""
	@echo "使用方法:"
	@echo "  make        - 编译程序"
	@echo "  make clean  - 清理编译文件"
	@echo "  make help   - 显示此帮助"
	@echo ""
	@echo "环境:"
ifeq ($(OS),Windows_NT)
	@echo "  当前系统: Windows (MSVC)"
else
	@echo "  当前系统: Linux (MinGW 交叉编译)"
endif
	@echo "  编译器: $(CC)"
	@echo "  输出: $(OUTPUT)"
