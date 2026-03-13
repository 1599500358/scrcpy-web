// ScrcpyConsole - Windows 控制台客户端
// 自动检测 ADB 设备并连接到中继服务器

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wincodec.h>
#include <ole2.h>
#include <process.h>  // 添加线程支持

// WebRTC 支持（可选，编译时使用 -D USE_WEBRTC 启用）
#ifdef USE_WEBRTC
#include "webrtc_support.h"
#endif

// WIC 接口 GUID 声明（使用 extern 避免重复定义）
/*
extern const GUID CLSID_WICImagingFactory;
extern const GUID GUID_ContainerFormatPng;
extern const GUID GUID_ContainerFormatJpeg;
extern const GUID GUID_WICPixelFormat24bppBGR;
*/

#define BUFFER_SIZE 8192
#define WS_RECV_BUFFER_SIZE (1024 * 256) // 256KB WebSocket 接收缓冲区
#define MAX_DEVICES 32
#define MAX_WS_PAYLOAD_SIZE (1024 * 1024) // 1MB 最大 WebSocket 消息
#define VERSION "1.2.0"
#define MAX_RECONNECT_ATTEMPTS 10
#define RECONNECT_BASE_DELAY 1000 // 初始重连延迟 1 秒

// WebRTC 配置
#ifdef USE_WEBRTC
#define WEBRTC_STUN_SERVER "stun.l.google.com:19302"
static bool g_webrtc_enabled = false;
static WebRTCConfig g_webrtc_config = {0};
#endif

// 线程参数结构
typedef struct {
    int device_index;
} ScreenshotThreadParams;

// 设备信息结构
typedef struct {
    char serial[256];
    char state[32];
    char model[128];
    char custom_name[256];  // 自定义设备名称
    char* thumbnail_base64;  // 缩略图 Base64（动态分配）
    DWORD process_id;  // scrcpy 进程 ID
    bool streaming;    // 是否正在推流
} Device;

// 全局变量
SOCKET ws_socket = INVALID_SOCKET;
char client_id[64] = {0};
Device devices[MAX_DEVICES];
int device_count = 0;
bool running = true;
char server_url[256] = "localhost:8080";

// 添加缩略图更新标志和线程相关变量
bool thumbnail_update_pending = false;
bool thumbnail_update_running = false;
DWORD last_thumbnail_update = 0;
const DWORD THUMBNAIL_UPDATE_INTERVAL = 30000; // 30秒更新间隔
HANDLE thumbnail_thread = NULL;
CRITICAL_SECTION thumbnail_cs; // 用于线程同步

// ADB 路径缓存（只查找一次）
char cached_adb_path[512] = {0};
bool adb_path_resolved = false;

// WebSocket 接收缓冲区（用于组装完整帧）
char* ws_recv_buffer = NULL;
int ws_recv_buffer_len = 0;

// 函数声明
void print_banner();
void print_log(const char* level, const char* format, ...);
bool init_winsock();
bool connect_to_server();
bool send_websocket_message(const char* message);
bool receive_websocket_message(char* buffer, int buffer_size);
int execute_adb_command(const char* command, char* output, int output_size);
int scan_adb_devices();
void send_device_list();
void send_device_list_async();
unsigned __stdcall thumbnail_update_thread(void* param); // 缩略图更新线程函数
void handle_server_message(const char* message);
void console_loop();
void cleanup();
void stop_device(const char* serial);
void stop_all_devices();
void capture_device_screenshot(int device_index);
void load_device_names();
void save_device_name(const char* serial, const char* custom_name);
void base64_encode(const unsigned char* input, int length, char* output);
unsigned __stdcall capture_screenshot_thread(void* param);
const char* resolve_adb_path();
bool is_valid_serial(const char* serial);
void free_device_thumbnails();
void send_updated_device_list();

// JSON 简单构建（实际项目建议使用 cJSON 库）
void json_escape_string(const char* input, char* output, int output_size) {
    int j = 0;
    for (int i = 0; input[i] && j < output_size - 2; i++) {
        if (input[i] == '"' || input[i] == '\\') {
            output[j++] = '\\';
        }
        output[j++] = input[i];
    }
    output[j] = '\0';
}

int main(int argc, char* argv[]) {
    // 设置控制台为 UTF-8 编码
    SetConsoleOutputCP(65001);
    SetConsoleCP(65001);
    
    // 初始化临界区
    InitializeCriticalSection(&thumbnail_cs);
    
    // 初始化 COM（主线程）
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    
    // 分配 WebSocket 接收缓冲区
    ws_recv_buffer = (char*)malloc(WS_RECV_BUFFER_SIZE);
    if (!ws_recv_buffer) {
        print_log("ERROR", "无法分配 WebSocket 接收缓冲区");
        CoUninitialize();
        DeleteCriticalSection(&thumbnail_cs);
        return 1;
    }
    ws_recv_buffer_len = 0;
    
    // 初始化设备 thumbnail 指针
    for (int i = 0; i < MAX_DEVICES; i++) {
        devices[i].thumbnail_base64 = NULL;
    }
    
    print_banner();

    // 解析命令行参数
    if (argc > 1) {
        strncpy(server_url, argv[1], sizeof(server_url) - 1);
    }

#ifdef USE_WEBRTC
    // 初始化 WebRTC
    print_log("INFO", "初始化 WebRTC...");
    strncpy(g_webrtc_config.stun_server, WEBRTC_STUN_SERVER, sizeof(g_webrtc_config.stun_server) - 1);
    // TURN 服务器配置可从环境变量读取
    char* turn_host = getenv("TURN_HOST");
    char* turn_user = getenv("TURN_USERNAME");
    char* turn_pass = getenv("TURN_CREDENTIAL");
    if (turn_host) strncpy(g_webrtc_config.turn_server, turn_host, sizeof(g_webrtc_config.turn_server) - 1);
    if (turn_user) strncpy(g_webrtc_config.turn_username, turn_user, sizeof(g_webrtc_config.turn_username) - 1);
    if (turn_pass) strncpy(g_webrtc_config.turn_password, turn_pass, sizeof(g_webrtc_config.turn_password) - 1);

    g_webrtc_enabled = webrtc_init(&g_webrtc_config);
    if (g_webrtc_enabled) {
        print_log("SUCCESS", "WebRTC 初始化成功");
    } else {
        print_log("WARNING", "WebRTC 初始化失败，将使用 WebSocket 模式");
    }
#endif
    
    print_log("INFO", "服务器地址: %s", server_url);
    
    // 初始化 Winsock
    if (!init_winsock()) {
        print_log("ERROR", "Winsock 初始化失败");
        free(ws_recv_buffer);
        CoUninitialize();
        DeleteCriticalSection(&thumbnail_cs);
        return 1;
    }
    
    // 预解析 ADB 路径
    resolve_adb_path();
    
    // 自动重连循环
    int reconnect_attempts = 0;
    while (running) {
        // 连接到服务器
        if (!connect_to_server()) {
            reconnect_attempts++;
            if (reconnect_attempts > MAX_RECONNECT_ATTEMPTS) {
                print_log("ERROR", "已达到最大重连次数 (%d)，退出", MAX_RECONNECT_ATTEMPTS);
                break;
            }
            // 指数退避重连
            DWORD delay = RECONNECT_BASE_DELAY * (1 << (reconnect_attempts - 1));
            if (delay > 60000) delay = 60000; // 最长 60 秒
            print_log("WARNING", "无法连接到服务器，%lu 毫秒后重试 (第 %d/%d 次)...", 
                       delay, reconnect_attempts, MAX_RECONNECT_ATTEMPTS);
            Sleep(delay);
            continue;
        }
        
        // 连接成功，重置重连计数
        reconnect_attempts = 0;
        print_log("SUCCESS", "已连接到中继服务器");
        
        // 扫描 ADB 设备
        device_count = scan_adb_devices();
        print_log("INFO", "检测到 %d 个 ADB 设备", device_count);
        
        if (device_count > 0) {
            send_device_list();
            last_thumbnail_update = GetTickCount();
        }
        
        // 启动缩略图更新线程
        thumbnail_thread = (HANDLE)_beginthreadex(NULL, 0, thumbnail_update_thread, NULL, 0, NULL);

        // 进入主循环（会在连接断开时返回）
        console_loop();
        
        // 等待缩略图线程结束
        if (thumbnail_thread) {
            WaitForSingleObject(thumbnail_thread, 5000); // 最多等 5 秒
            CloseHandle(thumbnail_thread);
            thumbnail_thread = NULL;
        }
        
        // 关闭当前 socket
        if (ws_socket != INVALID_SOCKET) {
            closesocket(ws_socket);
            ws_socket = INVALID_SOCKET;
        }
        
        if (!running) break;
        
        print_log("INFO", "连接断开，准备重连...");
        Sleep(1000);
    }
    
    cleanup();
    free_device_thumbnails();
    free(ws_recv_buffer);
    CoUninitialize();
    DeleteCriticalSection(&thumbnail_cs);
    return 0;
}

void print_banner() {
    printf("\n");
    printf("========================================\n");
    printf("  Scrcpy Console Client v%s\n", VERSION);
    printf("  远程控制客户端\n");
    printf("========================================\n");
    printf("\n");
}

void print_log(const char* level, const char* format, ...) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    
    // 设置颜色
    HANDLE hConsole = GetStdHandle(STD_OUTPUT_HANDLE);
    if (strcmp(level, "ERROR") == 0) {
        SetConsoleTextAttribute(hConsole, FOREGROUND_RED | FOREGROUND_INTENSITY);
    } else if (strcmp(level, "SUCCESS") == 0) {
        SetConsoleTextAttribute(hConsole, FOREGROUND_GREEN | FOREGROUND_INTENSITY);
    } else if (strcmp(level, "WARNING") == 0) {
        SetConsoleTextAttribute(hConsole, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_INTENSITY);
    } else {
        SetConsoleTextAttribute(hConsole, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE);
    }
    
    printf("[%02d:%02d:%02d] [%s] ", st.wHour, st.wMinute, st.wSecond, level);
    
    va_list args;
    va_start(args, format);
    vprintf(format, args);
    va_end(args);
    
    printf("\n");
    
    // 恢复颜色
    SetConsoleTextAttribute(hConsole, FOREGROUND_RED | FOREGROUND_GREEN | FOREGROUND_BLUE);
}

bool init_winsock() {
    WSADATA wsaData;
    int result = WSAStartup(MAKEWORD(2, 2), &wsaData);
    return result == 0;
}

bool connect_to_server() {
    struct addrinfo hints, *result = NULL;
    
    ZeroMemory(&hints, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    
    // 解析服务器地址
    char host[256], port[16];
    char* colon = strchr(server_url, ':');
    if (colon) {
        int host_len = colon - server_url;
        strncpy(host, server_url, host_len);
        host[host_len] = '\0';
        strcpy(port, colon + 1);
    } else {
        strcpy(host, server_url);
        strcpy(port, "8080");
    }
    
    if (getaddrinfo(host, port, &hints, &result) != 0) {
        return false;
    }
    
    // 创建 socket
    ws_socket = socket(result->ai_family, result->ai_socktype, result->ai_protocol);
    if (ws_socket == INVALID_SOCKET) {
        freeaddrinfo(result);
        return false;
    }
    
    // 连接
    if (connect(ws_socket, result->ai_addr, (int)result->ai_addrlen) == SOCKET_ERROR) {
        closesocket(ws_socket);
        ws_socket = INVALID_SOCKET;
        freeaddrinfo(result);
        return false;
    }
    
    freeaddrinfo(result);
    
    // 发送 WebSocket 握手
    char handshake[1024];
    sprintf(handshake,
        "GET /?type=console HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n",
        host);
    
    send(ws_socket, handshake, strlen(handshake), 0);
    
    // 接收握手响应
    char response[2048];
    recv(ws_socket, response, sizeof(response), 0);
    
    if (strstr(response, "101 Switching Protocols") == NULL) {
        return false;
    }
    
    return true;
}

bool send_websocket_message(const char* message) {
    int len = strlen(message);
    print_log("DEBUG", "准备发送WebSocket消息，长度: %d 字节", len);
    
    // 检查消息是否太大
    if (len >= MAX_WS_PAYLOAD_SIZE) {
        print_log("ERROR", "消息太大，无法发送: %d 字节", len);
        return false;
    }
    
    // 动态分配帧缓冲区（头部最多14字节 + 负载）
    int max_frame_size = 14 + len;
    unsigned char* frame = (unsigned char*)malloc(max_frame_size);
    if (!frame) {
        print_log("ERROR", "无法分配发送缓冲区: %d 字节", max_frame_size);
        return false;
    }
    int frame_len = 0;
    
    // WebSocket frame header
    frame[0] = 0x81; // FIN + text frame
    
    if (len < 126) {
        frame[1] = 0x80 | len; // MASK + length
        frame_len = 2;
    } else if (len < 65536) {
        frame[1] = 0x80 | 126;
        frame[2] = (len >> 8) & 0xFF;
        frame[3] = len & 0xFF;
        frame_len = 4;
    } else {
        // 支持 64-bit 长度（大消息如包含缩略图的设备信息）
        frame[1] = 0x80 | 127;
        frame[2] = 0; frame[3] = 0; frame[4] = 0; frame[5] = 0;
        frame[6] = (len >> 24) & 0xFF;
        frame[7] = (len >> 16) & 0xFF;
        frame[8] = (len >> 8) & 0xFF;
        frame[9] = len & 0xFF;
        frame_len = 10;
    }
    
    // 生成随机 Masking key（符合 RFC 6455 规范）
    unsigned char mask[4];
    HCRYPTPROV hProv = 0;
    if (CryptAcquireContext(&hProv, NULL, NULL, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT)) {
        CryptGenRandom(hProv, 4, mask);
        CryptReleaseContext(hProv, 0);
    } else {
        // 降级：使用 rand（仍然比固定值好）
        srand((unsigned int)(GetTickCount() ^ (DWORD)(size_t)&mask));
        mask[0] = rand() & 0xFF;
        mask[1] = rand() & 0xFF;
        mask[2] = rand() & 0xFF;
        mask[3] = rand() & 0xFF;
    }
    
    memcpy(&frame[frame_len], mask, 4);
    frame_len += 4;
    
    // Masked payload
    for (int i = 0; i < len; i++) {
        frame[frame_len + i] = message[i] ^ mask[i % 4];
    }
    frame_len += len;
    
    print_log("DEBUG", "WebSocket帧构建完成，帧长度: %d 字节", frame_len);
    
    // 循环发送确保完整发出
    int total_sent = 0;
    bool result = true;
    while (total_sent < frame_len) {
        int sent = send(ws_socket, (char*)frame + total_sent, frame_len - total_sent, 0);
        if (sent <= 0) {
            print_log("ERROR", "WebSocket消息发送失败，已发送: %d/%d 字节", total_sent, frame_len);
            result = false;
            break;
        }
        total_sent += sent;
    }
    
    if (result) {
        print_log("DEBUG", "WebSocket消息发送成功");
    }

    free(frame);
    return result;
}

#ifdef USE_WEBRTC
// WebRTC 信令消息回调函数
void webrtc_send_signaling_message(const char* device_id, const char* message) {
    if (!device_id || !message) return;

    print_log("DEBUG", "[WebRTC] 发送信令消息: %s", message);
    send_websocket_message(message);
}
#endif

// ADB 路径解析（只查找一次并缓存结果）
const char* resolve_adb_path() {
    if (adb_path_resolved) {
        return cached_adb_path;
    }
    
    // 1. 优先使用环境变量 ADB
    char* adb_env = getenv("ADB");
    if (adb_env && adb_env[0]) {
        strncpy(cached_adb_path, adb_env, sizeof(cached_adb_path) - 1);
        adb_path_resolved = true;
        print_log("INFO", "使用环境变量 ADB 路径: %s", cached_adb_path);
        return cached_adb_path;
    }
    
    // 2. 尝试多个可能的路径
    const char* adb_paths[] = {
        "adb",                                    // PATH 中的 adb
        ".\\platform-tools\\adb.exe",            // 当前目录
        "..\\platform-tools\\adb.exe",           // 上级目录
        ".\\adb.exe",                            // 当前目录直接放置
        "C:\\platform-tools\\adb.exe",           // C 盘
        "C:\\adb\\adb.exe",                      // C:\\adb
        NULL
    };
    
    for (int i = 0; adb_paths[i] != NULL; i++) {
        char test_cmd[512];
        sprintf(test_cmd, "%s version >nul 2>&1", adb_paths[i]);
        if (system(test_cmd) == 0) {
            strncpy(cached_adb_path, adb_paths[i], sizeof(cached_adb_path) - 1);
            adb_path_resolved = true;
            print_log("INFO", "找到 ADB: %s", cached_adb_path);
            return cached_adb_path;
        }
    }
    
    // 默认使用 PATH 中的
    strcpy(cached_adb_path, "adb");
    adb_path_resolved = true;
    print_log("WARNING", "未找到 ADB，默认使用 PATH 中的 adb");
    return cached_adb_path;
}

// Serial 白名单校验（防止命令注入）
bool is_valid_serial(const char* serial) {
    if (!serial || !serial[0]) return false;
    for (int i = 0; serial[i]; i++) {
        char c = serial[i];
        // 只允许字母、数字、点、冒号、短横线、下划线
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || 
              (c >= '0' && c <= '9') || c == '.' || c == ':' || 
              c == '-' || c == '_')) {
            print_log("WARNING", "非法 serial 字符: '%c' in \"%s\"", c, serial);
            return false;
        }
    }
    return true;
}

// 释放所有设备的缩略图内存
void free_device_thumbnails() {
    for (int i = 0; i < MAX_DEVICES; i++) {
        if (devices[i].thumbnail_base64) {
            free(devices[i].thumbnail_base64);
            devices[i].thumbnail_base64 = NULL;
        }
    }
}

int execute_adb_command(const char* command, char* output, int output_size) {
    char cmd[512];
    const char* adb_exe = resolve_adb_path();
    sprintf(cmd, "%s %s 2>&1", adb_exe, command);
    
    FILE* pipe = _popen(cmd, "r");
    if (!pipe) {
        return -1;
    }
    
    int total_read = 0;
    while (fgets(output + total_read, output_size - total_read, pipe) != NULL) {
        total_read = strlen(output);
    }
    
    int exit_code = _pclose(pipe);
    return exit_code;
}

int scan_adb_devices() {
    char adb_output[BUFFER_SIZE];
    
    print_log("INFO", "正在扫描 ADB 设备...");
    
    int exit_code = execute_adb_command("devices -l", adb_output, sizeof(adb_output));
    
    if (exit_code != 0) {
        static bool first_warning = true;
        if (first_warning) {
            print_log("ERROR", "无法执行 adb 命令");
            print_log("INFO", "请确保 ADB 已安装并在以下位置之一:");
            print_log("INFO", "  1. 添加到系统 PATH 环境变量");
            print_log("INFO", "  2. 放在 platform-tools\\ 目录");
            print_log("INFO", "  3. 安装在 C:\\platform-tools\\ 或 C:\\adb\\");
            print_log("INFO", "");
            print_log("INFO", "下载地址: https://developer.android.com/studio/releases/platform-tools");
            first_warning = false;
        }
        return 0;
    }
    
    device_count = 0;
    char* line = strtok(adb_output, "\n");
    bool header_found = false;
    
    while (line != NULL && device_count < MAX_DEVICES) {
        // 跳过表头
        if (strstr(line, "List of devices attached") != NULL) {
            header_found = true;
            line = strtok(NULL, "\n");
            continue;
        }
        
        if (!header_found) {
            line = strtok(NULL, "\n");
            continue;
        }
        
        // 跳过空行
        if (strlen(line) == 0 || line[0] == '\r') {
            line = strtok(NULL, "\n");
            continue;
        }
        
        // 解析设备行
        char serial[256], state[32], model[128];
        serial[0] = '\0';
        state[0] = '\0';
        model[0] = '\0';
        
        // 格式: serial\tstate 或 serial  state (多个空格)
        // 先尝试 tab 分隔
        char* tab = strchr(line, '\t');
        char* separator = tab;
        
        // 如果没有 tab，尝试多个空格
        if (!separator) {
            char* space = line;
            while (*space && *space != ' ') space++;
            if (*space == ' ') {
                // 跳过所有空格
                while (*space == ' ') space++;
                if (*space) {
                    separator = space - 1; // 指向最后一个空格
                }
            }
        }
        
        if (separator && separator > line) {
            int serial_len = (tab ? tab : separator) - line;
            if (serial_len > 0 && serial_len < (int)sizeof(serial)) {
                strncpy(serial, line, serial_len);
                serial[serial_len] = '\0';
                
                // 移除 serial 末尾的空格
                while (serial_len > 0 && serial[serial_len - 1] == ' ') {
                    serial[--serial_len] = '\0';
                }
                
                // 获取状态
                char* state_start = (tab ? tab + 1 : separator + 1);
                while (*state_start == ' ' || *state_start == '\t') state_start++;
                
                if (*state_start) {
                    sscanf(state_start, "%31s", state);
                    
                    // 查找 model:
                    char* model_marker = strstr(state_start, "model:");
                    if (model_marker) {
                        sscanf(model_marker + 6, "%127s", model);
                    }
                    
                    // 添加到设备列表
                    if (strlen(serial) > 0 && strlen(state) > 0) {
                        strcpy(devices[device_count].serial, serial);
                        strcpy(devices[device_count].state, state);
                        strcpy(devices[device_count].model, model[0] ? model : "Unknown");
                        
                        print_log("INFO", "  [%d] %s - %s (%s)",
                            device_count + 1,
                            devices[device_count].serial,
                            devices[device_count].state,
                            devices[device_count].model);
                        
                        device_count++;
                    }
                }
            }
        }
        
        line = strtok(NULL, "\n");
    }
    
    return device_count;
}

void send_device_list() {
    // 加载设备名称
    load_device_names();
    
    // 为每个设备设置默认名称
    const int total_devices = device_count;
    for (int i = 0; i < total_devices; i++) {
        if (devices[i].custom_name[0] == '\0') {
            strncpy(devices[i].custom_name, devices[i].model, sizeof(devices[i].custom_name) - 1);
        }
    }
    
    // 触发异步缩略图更新，而不是同步获取
    send_device_list_async();
    
    // 立即发送当前设备信息（可能不包含最新缩略图）
    for (int i = 0; i < total_devices; i++) {
        char* message = (char*)malloc(BUFFER_SIZE * 10);  // 分配足够空间
        if (!message) {
            print_log("ERROR", "内存分配失败");
            continue;
        }
        
        char escaped_serial[256], escaped_model[128], escaped_name[256];
        json_escape_string(devices[i].serial, escaped_serial, sizeof(escaped_serial));
        json_escape_string(devices[i].model, escaped_model, sizeof(escaped_model));
        json_escape_string(devices[i].custom_name, escaped_name, sizeof(escaped_name));

        sprintf(message,
            "{\"type\":\"deviceUpdate\",\"device\":{\"serial\":\"%s\",\"state\":\"%s\",\"model\":\"%s\",\"customName\":\"%s\",\"thumbnail\":\"%s\"}}",
            escaped_serial,
            devices[i].state,
            escaped_model,
            escaped_name,
            devices[i].thumbnail_base64 ? devices[i].thumbnail_base64 : "");

        print_log("DEBUG", "发送设备信息: %s", message);

        send_websocket_message(message);
        free(message);

        print_log("INFO", "设备 %s 信息已发送到服务器", devices[i].serial);
    }
}

void send_device_list_async() {
    EnterCriticalSection(&thumbnail_cs);
    thumbnail_update_pending = true;
    LeaveCriticalSection(&thumbnail_cs);
}

// 缩略图更新线程函数
unsigned __stdcall thumbnail_update_thread(void* param) {
    // 为线程初始化COM环境
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    
    // 避免未使用参数警告
    (void)param;
    
    while (running) {
        // 检查是否需要更新缩略图
        bool should_update = false;
        EnterCriticalSection(&thumbnail_cs);
        if (thumbnail_update_pending || GetTickCount() - last_thumbnail_update > THUMBNAIL_UPDATE_INTERVAL) {
            should_update = true;
            thumbnail_update_pending = false;
        }
        LeaveCriticalSection(&thumbnail_cs);

        if (should_update && device_count > 0) {
            // 限制并行线程数量，避免对系统造成过大压力
            const int MAX_CONCURRENT_THREADS = 8;  // 最多同时处理8个设备
            const int total_devices = device_count;
            
            // 并行获取所有设备的缩略图
            if (total_devices > 1) {
                // 分批处理设备，避免创建过多线程
                for (int batch_start = 0; batch_start < total_devices; batch_start += MAX_CONCURRENT_THREADS) {
                    int batch_end = batch_start + MAX_CONCURRENT_THREADS;
                    if (batch_end > total_devices) {
                        batch_end = total_devices;
                    }
                    
                    int batch_size = batch_end - batch_start;
                    HANDLE* threads = (HANDLE*)malloc(batch_size * sizeof(HANDLE));
                    ScreenshotThreadParams* params = (ScreenshotThreadParams*)malloc(batch_size * sizeof(ScreenshotThreadParams));
                    
                    if (threads && params) {
                        // 创建线程
                        for (int i = 0; i < batch_size; i++) {
                            int device_index = batch_start + i;
                            params[i].device_index = device_index;
                            threads[i] = (HANDLE)_beginthreadex(NULL, 0, capture_screenshot_thread, &params[i], 0, NULL);
                        }
                        
                        // 等待批次中的所有线程完成
                        WaitForMultipleObjects(batch_size, threads, TRUE, INFINITE);
                        
                        // 关闭线程句柄
                        for (int i = 0; i < batch_size; i++) {
                            if (threads[i]) {
                                CloseHandle(threads[i]);
                            }
                        }
                    }
                    
                    // 释放内存
                    if (threads) free(threads);
                    if (params) free(params);
                }
            } else if (total_devices == 1) {
                // 单个设备直接处理
                capture_device_screenshot(0);
            }
            
            // 更新时间戳
            EnterCriticalSection(&thumbnail_cs);
            last_thumbnail_update = GetTickCount();
            LeaveCriticalSection(&thumbnail_cs);

            // 发送更新后的设备信息到服务器
            send_updated_device_list();
        }

        // 短暂休眠，避免过度占用CPU
        Sleep(1000);
    }
    
    // 清理COM环境
    CoUninitialize();
    
    return 0;
}

void handle_server_message(const char* message) {
    // 简单的 JSON 解析（实际项目建议使用 cJSON）
    if (strstr(message, "\"type\":\"welcome\"")) {
        // 提取 clientId
        char* id_start = strstr(message, "\"clientId\":\"");
        if (id_start) {
            id_start += 12;
            char* id_end = strchr(id_start, '"');
            if (id_end) {
                int len = id_end - id_start;
                strncpy(client_id, id_start, len);
                client_id[len] = '\0';
                print_log("SUCCESS", "客户端 ID: %s", client_id);
            }
        }
    } else if (strstr(message, "\"type\":\"prepareStreamResponse\"")) {
        // 预注册响应
        char* serial_start = strstr(message, "\"serial\":\"");
        char* success_start = strstr(message, "\"success\":true");
        
        if (serial_start && success_start) {
            serial_start += 11;
            char* serial_end = strchr(serial_start, '"');
            if (serial_end) {
                char serial[256];
                int len = serial_end - serial_start;
                strncpy(serial, serial_start, len);
                serial[len] = '\0';
                print_log("SUCCESS", "设备推流预注册成功: %s", serial);
            }
        }
    } else if (strstr(message, "\"type\":\"control\"")) {
        // 控制指令
        char* serial_start = strstr(message, "\"serial\":\"");
        char* action_start = strstr(message, "\"action\":\"");
        
        if (serial_start && action_start) {
            serial_start += 10;
            char* serial_end = strchr(serial_start, '"');
            action_start += 10;
            char* action_end = strchr(action_start, '"');
            
            if (serial_end && action_end) {
                char serial[256], action[64];
                int serial_len = serial_end - serial_start;
                int action_len = action_end - action_start;
                
                strncpy(serial, serial_start, serial_len);
                serial[serial_len] = '\0';
                strncpy(action, action_start, action_len);
                action[action_len] = '\0';
                
                print_log("INFO", "收到控制指令: %s for %s", action, serial);
                
                // 处理控制指令
                if (strcmp(action, "touch") == 0) {
                    // 触摸事件
                    char* x_start = strstr(message, "\"x\":");
                    char* y_start = strstr(message, "\"y\":");
                    char* touchType_start = strstr(message, "\"touchType\":\"");
                    
                    if (x_start && y_start && touchType_start) {
                        touchType_start += 13;
                        char* touchType_end = strchr(touchType_start, '"');
                        
                        float x, y;
                        sscanf(x_start + 4, "%f", &x);
                        sscanf(y_start + 4, "%f", &y);
                        
                        char touchType[16];
                        int touch_len = touchType_end - touchType_start;
                        strncpy(touchType, touchType_start, touch_len);
                        touchType[touch_len] = '\0';
                        
                        // TODO: 实现触摸事件（需要修改 scrcpy 或使用 ADB）
                        print_log("INFO", "  Touch: type=%s, x=%.2f, y=%.2f", touchType, x, y);
                    }
                } else {
                    // 按键控制（home, back, etc.）
                    char adb_cmd[512];
                    const char* keycode = NULL;
                    
                    if (strcmp(action, "home") == 0) {
                        keycode = "KEYCODE_HOME";
                    } else if (strcmp(action, "back") == 0) {
                        keycode = "KEYCODE_BACK";
                    } else if (strcmp(action, "recent") == 0) {
                        keycode = "KEYCODE_APP_SWITCH";
                    } else if (strcmp(action, "power") == 0) {
                        keycode = "KEYCODE_POWER";
                    } else if (strcmp(action, "volumeUp") == 0) {
                        keycode = "KEYCODE_VOLUME_UP";
                    } else if (strcmp(action, "volumeDown") == 0) {
                        keycode = "KEYCODE_VOLUME_DOWN";
                    }
                    
                    if (keycode) {
                        if (!is_valid_serial(serial)) {
                            print_log("ERROR", "无效的设备序列号: %s", serial);
                        } else {
                            sprintf(adb_cmd, "-s %s shell input keyevent %s", serial, keycode);
                            char output[BUFFER_SIZE];
                            int result = execute_adb_command(adb_cmd, output, sizeof(output));
                            if (result == 0) {
                                print_log("SUCCESS", "执行成功: %s", action);
                            } else {
                                print_log("ERROR", "执行失败: %s", action);
                            }
                        }
                    }
                }
            }
        }
    } else if (strstr(message, "\"type\":\"startDevice\"")) {
        // 服务器请求启动某个设备的推流
        print_log("DEBUG", "收到startDevice消息: %s", message);
        
        char* serial_start = strstr(message, "\"serial\":\"");
        if (serial_start) {
            serial_start += 10;
            char* serial_end = strchr(serial_start, '"');
            if (serial_end) {
                char serial[256];
                int len = serial_end - serial_start;
                strncpy(serial, serial_start, len);
                serial[len] = '\0';
                
                print_log("INFO", "服务器请求启动设备: %s", serial);
                
                // 验证 serial 安全性
                if (!is_valid_serial(serial)) {
                    print_log("ERROR", "无效的设备序列号: %s，拒绝启动", serial);
                    return;
                }
                
                // 预注册设备推流
                char prepare_msg[512];
                sprintf(prepare_msg, "{\"type\":\"prepareStream\",\"serial\":\"%s\",\"consoleId\":\"%s\"}", serial, client_id);
                if (send_websocket_message(prepare_msg)) {
                    print_log("INFO", "已预注册设备推流: %s", serial);
                } else {
                    print_log("ERROR", "预注册设备推流失败: %s", serial);
                }
                
                // 等待一小段时间确保服务器处理预注册
                Sleep(500);
                
                // 启动 scrcpy 推流
                char scrcpy_cmd[1024];
                
                // 构建 scrcpy 命令 - 使用 WebSocket 推流模式
                // 使用当前目录的 scrcpy.exe（确保使用编译的新版本）
                // --websocket-server: 连接到中继服务器
                // --no-video-playback: 禁用本地窗口显示
                // --no-audio: 禁用音频（简化）
                // --video-codec-options profile:int=1: 强制使用 H.264 Baseline Profile
                //   (1 = AVCProfileBaseline, 浏览器 WebCodecs 兼容性最好)
                // 直接启动scrcpy.exe以获取正确的进程ID
                sprintf(scrcpy_cmd, ".\\scrcpy.exe -s %s --websocket-server=%s --no-video-playback --no-audio --video-codec-options profile:int=1", 
                    serial, server_url);
                
                print_log("INFO", "启动命令: %s", scrcpy_cmd);
                print_log("INFO", "WebSocket 中继服务器: %s", server_url);
                
                // 使用 CreateProcess 启动，以便获取进程 ID
                STARTUPINFOA si;
                PROCESS_INFORMATION pi;
                ZeroMemory(&si, sizeof(si));
                si.cb = sizeof(si);
                // 隐藏窗口
                si.dwFlags = STARTF_USESHOWWINDOW;
                si.wShowWindow = SW_HIDE;  // 隐藏窗口
                ZeroMemory(&pi, sizeof(pi));
                
                if (CreateProcessA(NULL, scrcpy_cmd, NULL, NULL, FALSE, 
                                  0, NULL, NULL, &si, &pi)) {
                    // 记录进程 ID
                    for (int i = 0; i < device_count; i++) {
                        if (strcmp(devices[i].serial, serial) == 0) {
                            devices[i].process_id = pi.dwProcessId;
                            devices[i].streaming = true;
                            break;
                        }
                    }
                    
                    CloseHandle(pi.hProcess);
                    CloseHandle(pi.hThread);
                    
                    print_log("SUCCESS", "已启动设备 %s 的镜像，进程 ID: %lu", serial, pi.dwProcessId);

                    // 通知服务器已开始推流
                    char notify_msg[512];
                    sprintf(notify_msg,
                        "{\"type\":\"startStreaming\",\"serial\":\"%s\"}",
                        serial);
                    send_websocket_message(notify_msg);

#ifdef USE_WEBRTC
                    // 如果 WebRTC 启用，创建 WebRTC Offer
                    if (g_webrtc_enabled) {
                        // 构建完整的 deviceId (consoleId:serial)
                        char full_device_id[512];
                        snprintf(full_device_id, sizeof(full_device_id), "%s:%s", client_id, serial);

                        print_log("INFO", "[WebRTC] 创建 Offer for device %s", full_device_id);

                        // 设置消息回调，用于发送 WebRTC 信令
                        webrtc_set_message_callback(webrtc_send_signaling_message);

                        // 创建 Offer
                        char* offer = webrtc_create_offer(full_device_id);
                        if (offer) {
                            print_log("INFO", "[WebRTC] Offer 已创建");
                            free(offer);
                        } else {
                            print_log("WARN", "[WebRTC] 创建 Offer 失败，使用 WebSocket 模式");
                        }
                    }
#endif
                } else {
                    print_log("ERROR", "启动设备 %s 失败，错误代码: %lu", serial, GetLastError());
                }
            } else {
                print_log("ERROR", "无法解析设备序列号");
            }
        } else {
            print_log("ERROR", "消息中缺少设备序列号");
        }
    } else if (strstr(message, "\"type\":\"stopDevice\"")) {
        // 服务器请求停止某个设备的推流
        char* serial_start = strstr(message, "\"serial\":\"");
        if (serial_start) {
            serial_start += 10;
            char* serial_end = strchr(serial_start, '"');
            if (serial_end) {
                char serial[256];
                int len = serial_end - serial_start;
                strncpy(serial, serial_start, len);
                serial[len] = '\0';
                
                print_log("INFO", "服务器请求停止设备: %s", serial);
                stop_device(serial);
            }
        }
    } else if (strstr(message, "\"type\":\"requestKeyFrame\"")) {
        // Web客户端请求关键帧
        char* serial_start = strstr(message, "\"serial\":\"");
        if (serial_start) {
            serial_start += 10;
            char* serial_end = strchr(serial_start, '"');
            if (serial_end) {
                char serial[256];
                int len = serial_end - serial_start;
                strncpy(serial, serial_start, len);
                serial[len] = '\0';
                
                print_log("INFO", "Web客户端请求设备 %s 的关键帧", serial);
                
                // 向scrcpy进程发送信号请求关键帧
                // 这里可以通过向scrcpy进程发送特定信号或使用其他IPC机制
                // 暂时记录请求，实际实现需要修改scrcpy源码
                print_log("INFO", "已向scrcpy进程转发关键帧请求: %s", serial);
            }
        }
    } else if (strstr(message, "\"type\":\"updateDeviceName\"")) {
        // 服务器请求更新设备名称 - 现在由服务端直接处理，控制台只需更新内存中的名称
        char* serial_start = strstr(message, "\"serial\":\"");
        char* name_start = strstr(message, "\"customName\":\"");
        
        if (serial_start && name_start) {
            serial_start += 10;
            char* serial_end = strchr(serial_start, '"');
            
            name_start += 14;
            char* name_end = strchr(name_start, '"');
            
            if (serial_end && name_end) {
                char serial[256], custom_name[256];
                int serial_len = serial_end - serial_start;
                int name_len = name_end - name_start;
                
                strncpy(serial, serial_start, serial_len);
                serial[serial_len] = '\0';
                strncpy(custom_name, name_start, name_len);
                custom_name[name_len] = '\0';
                
                print_log("INFO", "更新设备名称: %s -> %s", serial, custom_name);
                
                // 只更新内存中的设备名称，不再保存到文件
                for (int i = 0; i < device_count; i++) {
                    if (strcmp(devices[i].serial, serial) == 0) {
                        strncpy(devices[i].custom_name, custom_name, sizeof(devices[i].custom_name) - 1);
                        break;
                    }
                }
                
                // 重新发送设备列表
                send_device_list();
            }
        }
    }
#ifdef USE_WEBRTC
    else if (strstr(message, "\"type\":\"webrtc-answer\"")) {
        // WebRTC Answer from Web client
        print_log("INFO", "[WebRTC] 收到 Answer");

        char* device_id_start = strstr(message, "\"deviceId\":\"");
        char* sdp_start = strstr(message, "\"sdp\":");

        if (device_id_start && sdp_start) {
            device_id_start += 12;
            char* device_id_end = strchr(device_id_start, '"');
            if (device_id_end) {
                char device_id[256];
                int len = device_id_end - device_id_start;
                strncpy(device_id, device_id_start, len);
                device_id[len] = '\0';

                // 提取 SDP
                // 格式: "sdp":{"type":"answer","sdp":"v=0\r\n..."}
                char* sdp_value_start = strstr(sdp_start, "\"sdp\":\"");
                if (sdp_value_start) {
                    sdp_value_start += 7;

                    // 找到 SDP 结束位置 - 查找 "}," 或 "}" 作为结束
                    char* sdp_end = strstr(sdp_value_start, "\"}}");
                    if (!sdp_end) {
                        sdp_end = strstr(sdp_value_start, "\"}");
                    }
                    if (!sdp_end) {
                        // 回退：找最后一个引号
                        char* last_quote = strrchr(sdp_value_start, '"');
                        if (last_quote) {
                            sdp_end = last_quote;
                        }
                    }

                    if (sdp_end) {
                        // 提取并反转义 SDP
                        char* sdp = (char*)malloc(8192);
                        if (sdp) {
                            char* dst = sdp;
                            char* src = sdp_value_start;
                            while (src < sdp_end && (dst - sdp) < 8190) {
                                if (*src == '\\' && *(src + 1) == 'r') {
                                    *dst++ = '\r';
                                    src += 2;
                                } else if (*src == '\\' && *(src + 1) == 'n') {
                                    *dst++ = '\n';
                                    src += 2;
                                } else if (*src == '\\' && *(src + 1) == '"') {
                                    *dst++ = '"';
                                    src += 2;
                                } else if (*src == '\\' && *(src + 1) == '\\') {
                                    *dst++ = '\\';
                                    src += 2;
                                } else {
                                    *dst++ = *src++;
                                }
                            }
                            *dst = '\0';

                            print_log("INFO", "[WebRTC] 设置远程 Answer: %s, SDP长度: %d", device_id, (int)strlen(sdp));
                            webrtc_set_answer(device_id, sdp);

                            free(sdp);
                        }
                    }
                }
            }
        }
    }
    else if (strstr(message, "\"type\":\"webrtc-ice-candidate\"")) {
        // WebRTC ICE Candidate
        print_log("DEBUG", "[WebRTC] 收到 ICE Candidate");

        char* device_id_start = strstr(message, "\"deviceId\":\"");
        char* candidate_start = strstr(message, "\"candidate\":");

        if (device_id_start && candidate_start) {
            device_id_start += 12;
            char* device_id_end = strchr(device_id_start, '"');
            if (device_id_end) {
                char device_id[256];
                int len = device_id_end - device_id_start;
                strncpy(device_id, device_id_start, len);
                device_id[len] = '\0';

                // 提取 candidate 字符串
                char* cand_value_start = strstr(candidate_start, "\"candidate\":\"");
                if (cand_value_start) {
                    cand_value_start += 13;
                    char* cand_end = strchr(cand_value_start, '"');
                    if (cand_end) {
                        char candidate[512];
                        int clen = cand_end - cand_value_start;
                        strncpy(candidate, cand_value_start, clen);
                        candidate[clen] = '\0';

                        print_log("DEBUG", "[WebRTC] 添加 ICE candidate: %s", device_id);
                        webrtc_add_ice_candidate(device_id, candidate);
                    }
                }
            }
        }
    }
#endif
}

// 停止设备推流
void stop_device(const char* serial) {
    for (int i = 0; i < device_count; i++) {
        if (strcmp(devices[i].serial, serial) == 0 && devices[i].streaming) {
            if (devices[i].process_id != 0) {
                // 打开进程句柄
                HANDLE hProcess = OpenProcess(PROCESS_TERMINATE, FALSE, devices[i].process_id);
                if (hProcess != NULL) {
                    // 终止进程
                    if (TerminateProcess(hProcess, 0)) {
                        print_log("SUCCESS", "已停止设备 %s 的推流，进程 ID: %lu", serial, devices[i].process_id);
                    } else {
                        print_log("ERROR", "无法终止进程 %lu", devices[i].process_id);
                    }
                    CloseHandle(hProcess);
                } else {
                    print_log("WARNING", "无法打开进程 %lu", devices[i].process_id);
                }
                
                devices[i].process_id = 0;
                devices[i].streaming = false;
            }
            break;
        }
    }
}

// 停止所有设备推流
void stop_all_devices() {
    print_log("INFO", "正在停止所有设备...");
    for (int i = 0; i < device_count; i++) {
        // 不管streaming状态如何，只要进程ID不为0就尝试停止
        if (devices[i].process_id != 0) {
            stop_device(devices[i].serial);
        }
    }
    
    // 强制终止所有scrcpy进程（额外保障）
    print_log("INFO", "正在强制终止所有scrcpy进程...");
    system("taskkill /F /IM scrcpy.exe /T >nul 2>nul");
}

void console_loop() {
    print_log("INFO", "进入主循环，等待服务器消息...");
    print_log("INFO", "按 Ctrl+C 退出");
    
    char recv_buf[BUFFER_SIZE];
    fd_set read_fds;
    struct timeval tv;
    
    // WebSocket 帧组装状态
    ws_recv_buffer_len = 0;
    
    // 记录上次设备扫描时间
    DWORD last_device_scan = 0;
    const DWORD DEVICE_SCAN_INTERVAL = 30000; // 30秒扫描一次
    
    while (running) {
        FD_ZERO(&read_fds);
        FD_SET(ws_socket, &read_fds);
        
        // 设置较短的超时时间，以便更频繁地检查消息
        tv.tv_sec = 1;  // 每 1 秒检查一次
        tv.tv_usec = 0;
        
        int result = select(0, &read_fds, NULL, NULL, &tv);
        
        if (result > 0 && FD_ISSET(ws_socket, &read_fds)) {
            // 有消息到达
            int received = recv(ws_socket, recv_buf, sizeof(recv_buf), 0);
            
            if (received <= 0) {
                print_log("WARNING", "与服务器连接断开");
                break;
            }
            
            // 追加到接收缓冲区
            if (ws_recv_buffer_len + received > WS_RECV_BUFFER_SIZE) {
                print_log("ERROR", "WebSocket 接收缓冲区溢出，重置");
                ws_recv_buffer_len = 0;
                continue;
            }
            memcpy(ws_recv_buffer + ws_recv_buffer_len, recv_buf, received);
            ws_recv_buffer_len += received;
            
            // 尝试解析完整的 WebSocket 帧
            while (ws_recv_buffer_len >= 2) {
                unsigned char* buf = (unsigned char*)ws_recv_buffer;
                int opcode = buf[0] & 0x0F;
                bool is_masked = (buf[1] & 0x80) != 0;
                int payload_len = buf[1] & 0x7F;
                int header_size = 2;
                
                if (payload_len == 126) {
                    if (ws_recv_buffer_len < 4) break; // 需要更多数据
                    payload_len = (buf[2] << 8) | buf[3];
                    header_size = 4;
                } else if (payload_len == 127) {
                    if (ws_recv_buffer_len < 10) break;
                    // 64-bit 长度（只取低 32 位，足够）
                    payload_len = (buf[6] << 24) | (buf[7] << 16) | (buf[8] << 8) | buf[9];
                    header_size = 10;
                }
                
                if (is_masked) header_size += 4; // 掩码键
                
                int total_frame_len = header_size + payload_len;
                if (ws_recv_buffer_len < total_frame_len) break; // 帧不完整，等待更多数据
                
                // 完整帧已就绪
                if (opcode == 0x01) { // Text frame
                    // 解除掩码（如果有）
                    char* payload = ws_recv_buffer + header_size;
                    if (is_masked) {
                        unsigned char* mask_key = buf + header_size - 4;
                        for (int i = 0; i < payload_len; i++) {
                            payload[i] ^= mask_key[i % 4];
                        }
                    }
                    
                    // 分配消息缓冲区并处理
                    char* message = (char*)malloc(payload_len + 1);
                    if (message) {
                        memcpy(message, payload, payload_len);
                        message[payload_len] = '\0';
                        
                        print_log("INFO", "收到服务器消息: %s", message);
                        handle_server_message(message);
                        free(message);
                    }
                } else if (opcode == 0x08) { // Close frame
                    print_log("INFO", "收到服务器关闭帧");
                    running = false;
                    break;
                } else if (opcode == 0x09) { // Ping frame
                    // 响应 Pong
                    unsigned char pong[2] = {0x8A, 0x80}; // FIN + Pong + MASK + 0 length
                    unsigned char pong_mask[4] = {0, 0, 0, 0};
                    char pong_frame[6];
                    memcpy(pong_frame, pong, 2);
                    memcpy(pong_frame + 2, pong_mask, 4);
                    send(ws_socket, pong_frame, 6, 0);
                }
                
                // 从缓冲区中移除已处理的帧
                int remaining = ws_recv_buffer_len - total_frame_len;
                if (remaining > 0) {
                    memmove(ws_recv_buffer, ws_recv_buffer + total_frame_len, remaining);
                }
                ws_recv_buffer_len = remaining;
            }
        } else if (result == 0) {
            // 超时，定期扫描设备（但不阻塞）
            DWORD current_time = GetTickCount();
            if (current_time - last_device_scan > DEVICE_SCAN_INTERVAL) {
                int new_count = scan_adb_devices();
                if (new_count != device_count) {
                    print_log("INFO", "设备列表已更新");
                    send_device_list();  // 这会触发异步缩略图更新
                }
                last_device_scan = current_time;
            }
        }
    }
}

void cleanup() {
    stop_all_devices();

#ifdef USE_WEBRTC
    // 清理 WebRTC 资源
    if (g_webrtc_enabled) {
        webrtc_cleanup();
        g_webrtc_enabled = false;
    }
#endif

    if (ws_socket != INVALID_SOCKET) {
        closesocket(ws_socket);
    }
    WSACleanup();
    
    print_log("INFO", "程序已退出");
}

// Base64 编码函数
void base64_encode(const unsigned char* input, int length, char* output) {
    static const char encoding_table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int i = 0, j = 0;
    
    for (i = 0; i < length - 2; i += 3) {
        output[j++] = encoding_table[(input[i] >> 2) & 0x3F];
        output[j++] = encoding_table[((input[i] & 0x3) << 4) | ((input[i + 1] & 0xF0) >> 4)];
        output[j++] = encoding_table[((input[i + 1] & 0xF) << 2) | ((input[i + 2] & 0xC0) >> 6)];
        output[j++] = encoding_table[input[i + 2] & 0x3F];
    }
    
    if (i < length) {
        output[j++] = encoding_table[(input[i] >> 2) & 0x3F];
        if (i == (length - 1)) {
            output[j++] = encoding_table[((input[i] & 0x3) << 4)];
            output[j++] = '=';
        } else {
            output[j++] = encoding_table[((input[i] & 0x3) << 4) | ((input[i + 1] & 0xF0) >> 4)];
            output[j++] = encoding_table[((input[i + 1] & 0xF) << 2)];
        }
        output[j++] = '=';
    }
    output[j] = '\0';
}

// 线程函数实现
unsigned __stdcall capture_screenshot_thread(void* param) {
    ScreenshotThreadParams* thread_params = (ScreenshotThreadParams*)param;
    int device_index = thread_params->device_index;
    
    // 为每个线程初始化COM环境
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    
    // 为当前设备捕获截图
    capture_device_screenshot(device_index);
    
    // 清理COM环境
    CoUninitialize();
    
    return 0;
}

// 捕获设备截图并生成缩略图（使用 WIC）
void capture_device_screenshot(int device_index) {
    if (device_index < 0 || device_index >= device_count) {
        return;
    }
    
    Device* device = &devices[device_index];
    char screenshot_path[512];
    char thumbnail_path[512];
    WCHAR screenshot_path_w[512];
    
    sprintf(screenshot_path, "screenshot_%s.png", device->serial);
    sprintf(thumbnail_path, "thumbnail_%s.jpg", device->serial);
    MultiByteToWideChar(CP_UTF8, 0, screenshot_path, -1, screenshot_path_w, 512);
    
    // 使用 ADB 直接保存截图到文件
    char adb_cmd[1024];
    const char* adb_exe = resolve_adb_path();
    
    // 截图并保存到设备
    char device_temp_path[256];
    sprintf(device_temp_path, "/sdcard/screenshot_%s.png", device->serial);
    
    // 验证 serial 安全性
    if (!is_valid_serial(device->serial)) {
        print_log("ERROR", "设备 %s serial 无效，跳过截图", device->serial);
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        return;
    }
    
    sprintf(adb_cmd, "%s -s %s shell screencap -p %s", adb_exe, device->serial, device_temp_path);
    
    // 使用 system() 执行命令（阻塞等待完成）
    int screencap_result = system(adb_cmd);
    if (screencap_result != 0) {
        print_log("WARNING", "设备 %s 截图命令失败: %d", device->serial, screencap_result);
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        return;
    }
    
    // 检查截图是否成功创建
    Sleep(300);
    
    sprintf(adb_cmd, "%s -s %s pull %s %s >nul 2>&1", adb_exe, device->serial, device_temp_path, screenshot_path);
    int result = system(adb_cmd);
    
    char cleanup_cmd[1024];
    sprintf(cleanup_cmd, "%s -s %s shell rm %s >nul 2>&1", adb_exe, device->serial, device_temp_path);
    system(cleanup_cmd);
    
    if (result != 0) {
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        return;
    }
    
    // 检查截图文件是否存在且不为空
    WIN32_FILE_ATTRIBUTE_DATA fileAttr;
    if (!GetFileAttributesExA(screenshot_path, GetFileExInfoStandard, &fileAttr) || 
        fileAttr.nFileSizeLow == 0) {
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        return;
    }
    
    // 使用 WIC 加载和压缩图片
    IWICImagingFactory* pFactory = NULL;
    HRESULT hr; // 声明hr变量
    hr = CoCreateInstance(
        &CLSID_WICImagingFactory,
        NULL,
        CLSCTX_INPROC_SERVER,
        &IID_IWICImagingFactory,
        (LPVOID*)&pFactory
    );
    
    if (FAILED(hr) || !pFactory) {
        print_log("WARNING", "设备 %s WIC 初始化失败: 0x%08X", device->serial, hr);
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        return;
    }
    
    // 加载 PNG 文件
    IWICBitmapDecoder* pDecoder = NULL;
    hr = pFactory->lpVtbl->CreateDecoderFromFilename(
        pFactory,
        screenshot_path_w,
        NULL,
        GENERIC_READ,
        WICDecodeMetadataCacheOnDemand,
        &pDecoder
    );
    
    if (FAILED(hr)) {
        print_log("WARNING", "设备 %s WIC 加载失败: 0x%08X", device->serial, hr);
        pFactory->lpVtbl->Release(pFactory);
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        return;
    }
    
    // 获取第一帧
    IWICBitmapFrameDecode* pFrame = NULL;
    hr = pDecoder->lpVtbl->GetFrame(pDecoder, 0, &pFrame);
    
    if (FAILED(hr)) {
        pDecoder->lpVtbl->Release(pDecoder);
        pFactory->lpVtbl->Release(pFactory);
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        return;
    }
    
    // 获取原始尺寸
    UINT width, height;
    pFrame->lpVtbl->GetSize(pFrame, &width, &height);
    
    print_log("INFO", "设备 %s 原始分辨率: %ux%u", device->serial, width, height);
    
    // 计算缩略图尺寸
    UINT thumb_height = 160;
    UINT thumb_width = (UINT)((float)width / height * thumb_height);
    if (thumb_width > 120) {
        thumb_width = 120;
        thumb_height = (UINT)((float)height / width * 120);
    }
    
    // 创建缩放器
    IWICBitmapScaler* pScaler = NULL;
    hr = pFactory->lpVtbl->CreateBitmapScaler(pFactory, &pScaler);
    
    if (SUCCEEDED(hr)) {
        hr = pScaler->lpVtbl->Initialize(
            pScaler,
            (IWICBitmapSource*)pFrame,
            thumb_width,
            thumb_height,
            WICBitmapInterpolationModeFant  // 高质量缩放
        );
    }
    
    if (FAILED(hr)) {
        pFrame->lpVtbl->Release(pFrame);
        pDecoder->lpVtbl->Release(pDecoder);
        pFactory->lpVtbl->Release(pFactory);
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        return;
    }
    
    // 保存为 JPEG（使用内存流）
    IWICStream* pStream = NULL;
    hr = pFactory->lpVtbl->CreateStream(pFactory, &pStream);
    
    // 创建空的内存流（自动增长）
    IStream* pMemStream = NULL;
    if (SUCCEEDED(hr)) {
        hr = CreateStreamOnHGlobal(NULL, TRUE, &pMemStream);  // NULL 表示自动分配内存
    }
    
    if (SUCCEEDED(hr)) {
        hr = pStream->lpVtbl->InitializeFromIStream(pStream, pMemStream);
    }
    
    IWICBitmapEncoder* pEncoder = NULL;
    if (SUCCEEDED(hr)) {
        hr = pFactory->lpVtbl->CreateEncoder(pFactory, &GUID_ContainerFormatJpeg, NULL, &pEncoder);
    }
    
    if (SUCCEEDED(hr)) {
        hr = pEncoder->lpVtbl->Initialize(pEncoder, (IStream*)pStream, WICBitmapEncoderNoCache);
    }
    
    IWICBitmapFrameEncode* pFrameEncode = NULL;
    IPropertyBag2* pPropertyBag = NULL;
    if (SUCCEEDED(hr)) {
        hr = pEncoder->lpVtbl->CreateNewFrame(pEncoder, &pFrameEncode, &pPropertyBag);
    }
    
    if (SUCCEEDED(hr)) {
        // 设置 JPEG 质量
        PROPBAG2 option = {0};
        option.pstrName = L"ImageQuality";
        VARIANT varValue;
        VariantInit(&varValue);
        varValue.vt = VT_R4;
        varValue.fltVal = 0.6f;
        pPropertyBag->lpVtbl->Write(pPropertyBag, 1, &option, &varValue);
        VariantClear(&varValue);
        
        hr = pFrameEncode->lpVtbl->Initialize(pFrameEncode, pPropertyBag);
    }
    
    if (SUCCEEDED(hr)) {
        hr = pFrameEncode->lpVtbl->WriteSource(pFrameEncode, (IWICBitmapSource*)pScaler, NULL);
    }
    
    if (SUCCEEDED(hr)) {
        hr = pFrameEncode->lpVtbl->Commit(pFrameEncode);
    }
    
    if (SUCCEEDED(hr)) {
        hr = pEncoder->lpVtbl->Commit(pEncoder);
    }
    
    // 释放编码器资源，确保数据完全写入内存流
    if (pFrameEncode) {
        pFrameEncode->lpVtbl->Release(pFrameEncode);
        pFrameEncode = NULL;
    }
    if (pPropertyBag) {
        pPropertyBag->lpVtbl->Release(pPropertyBag);
        pPropertyBag = NULL;
    }
    if (pEncoder) {
        pEncoder->lpVtbl->Release(pEncoder);
        pEncoder = NULL;
    }
    if (pStream) {
        pStream->lpVtbl->Release(pStream);
        pStream = NULL;
    }
    
    // 从内存流读取数据并写入文件
    BOOL write_success = FALSE;
    if (SUCCEEDED(hr) && pMemStream) {
        // 获取实际数据大小
        STATSTG stat;
        if (SUCCEEDED(pMemStream->lpVtbl->Stat(pMemStream, &stat, STATFLAG_NONAME))) {
            ULONG dataSize = (ULONG)stat.cbSize.QuadPart;
            
            // 重置流位置到开头
            LARGE_INTEGER zero = {{0}};
            pMemStream->lpVtbl->Seek(pMemStream, zero, STREAM_SEEK_SET, NULL);
            
            // 分配缓冲区并读取
            unsigned char* buffer = (unsigned char*)malloc(dataSize);
            if (buffer) {
                ULONG bytesRead = 0;
                if (SUCCEEDED(pMemStream->lpVtbl->Read(pMemStream, buffer, dataSize, &bytesRead)) && bytesRead > 0) {
                    // 写入文件
                    FILE* fp = fopen(thumbnail_path, "wb");
                    if (fp) {
                        fwrite(buffer, 1, bytesRead, fp);
                        fclose(fp);
                        write_success = TRUE;
                    }
                }
                free(buffer);
            }
        }
    }
    
    // 清理剩余资源
    if (pMemStream) {
        pMemStream->lpVtbl->Release(pMemStream);
        pMemStream = NULL;
    }
    if (pScaler) {
        pScaler->lpVtbl->Release(pScaler);
        pScaler = NULL;
    }
    if (pFrame) pFrame->lpVtbl->Release(pFrame);
    if (pDecoder) pDecoder->lpVtbl->Release(pDecoder);
    if (pFactory) pFactory->lpVtbl->Release(pFactory);
    
    if (FAILED(hr) || !write_success) {
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        return;
    }

    // 读取缩略图文件
    FILE* fp = fopen(thumbnail_path, "rb");
    if (fp == NULL) {
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        return;
    }
    
    // 获取文件大小
    fseek(fp, 0, SEEK_END);
    long thumb_size = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    
    // 限制最大 100KB
    if (thumb_size > 100 * 1024) {
        fclose(fp);
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        DeleteFileA(thumbnail_path);
        return;
    }
    
    // 读取文件内容
    unsigned char* buffer = (unsigned char*)malloc(thumb_size);
    if (buffer) {
        fread(buffer, 1, thumb_size, fp);
        fclose(fp);
        
        // Base64 编码（输出大小约为输入的 4/3 倍 + 对齐）
        size_t b64_size = ((thumb_size + 2) / 3) * 4 + 1;
        if (device->thumbnail_base64) free(device->thumbnail_base64);
        device->thumbnail_base64 = (char*)malloc(b64_size);
        if (device->thumbnail_base64) {
            base64_encode(buffer, thumb_size, device->thumbnail_base64);
        } else {
            print_log("ERROR", "设备 %s Base64内存分配失败", device->serial);
        }
        free(buffer);
    } else {
        fclose(fp);
        if (device->thumbnail_base64) { free(device->thumbnail_base64); device->thumbnail_base64 = NULL; }
        DeleteFileA(screenshot_path);
        DeleteFileA(thumbnail_path);
        return;
    }
    
    // 清理临时文件
    DeleteFileA(screenshot_path);
    DeleteFileA(thumbnail_path);
}

void send_updated_device_list() {
    // 逐个发送设备更新信息到服务器
    for (int i = 0; i < device_count; i++) {
        char* message = (char*)malloc(BUFFER_SIZE * 10);  // 分配足够空间
        if (!message) {
            print_log("ERROR", "内存分配失败");
            continue;
        }
        
        char escaped_serial[256], escaped_model[128], escaped_name[256];
        json_escape_string(devices[i].serial, escaped_serial, sizeof(escaped_serial));
        json_escape_string(devices[i].model, escaped_model, sizeof(escaped_model));
        json_escape_string(devices[i].custom_name, escaped_name, sizeof(escaped_name));

        sprintf(message,
            "{\"type\":\"deviceUpdate\",\"device\":{\"serial\":\"%s\",\"state\":\"%s\",\"model\":\"%s\",\"customName\":\"%s\",\"thumbnail\":\"%s\"}}",
            escaped_serial,
            devices[i].state,
            escaped_model,
            escaped_name,
            devices[i].thumbnail_base64 ? devices[i].thumbnail_base64 : "");
        
        //print_log("DEBUG", "发送设备更新信息: %s", message);
        
        send_websocket_message(message);
        free(message);
        
        print_log("INFO", "设备 %s 更新信息已发送到服务器", devices[i].serial);
    }
}

// 加载设备名称
void load_device_names() {
    FILE* fp = fopen("device_names.txt", "r");
    if (fp == NULL) {
        return;
    }
    
    char line[512];
    while (fgets(line, sizeof(line), fp)) {
        // 格式: serial|custom_name
        char* sep = strchr(line, '|');
        if (sep) {
            *sep = '\0';
            char* serial = line;
            char* name = sep + 1;
            
            // 移除换行符
            char* newline = strchr(name, '\n');
            if (newline) *newline = '\0';
            
            // 查找对应设备
            for (int i = 0; i < device_count; i++) {
                if (strcmp(devices[i].serial, serial) == 0) {
                    strncpy(devices[i].custom_name, name, sizeof(devices[i].custom_name) - 1);
                    break;
                }
            }
        }
    }
    
    fclose(fp);
}

// 保存设备名称
void save_device_name(const char* serial, const char* custom_name) {
    // 更新内存中的设备名称
    for (int i = 0; i < device_count; i++) {
        if (strcmp(devices[i].serial, serial) == 0) {
            strncpy(devices[i].custom_name, custom_name, sizeof(devices[i].custom_name) - 1);
            break;
        }
    }
    
    // 读取所有现有设备名称
    char all_names[MAX_DEVICES][512];
    int name_count = 0;
    
    FILE* fp = fopen("device_names.txt", "r");
    if (fp) {
        char line[512];
        while (fgets(line, sizeof(line), fp) && name_count < MAX_DEVICES) {
            char* sep = strchr(line, '|');
            if (sep) {
                *sep = '\0';
                if (strcmp(line, serial) != 0) {  // 跳过当前设备
                    *sep = '|';
                    strcpy(all_names[name_count++], line);
                }
            }
        }
        fclose(fp);
    }
    
    // 重新写入文件
    fp = fopen("device_names.txt", "w");
    if (fp == NULL) {
        print_log("ERROR", "无法保存设备名称");
        return;
    }
    
    // 写入其他设备名称
    for (int i = 0; i < name_count; i++) {
        fprintf(fp, "%s", all_names[i]);
    }
    
    // 写入当前设备名称
    fprintf(fp, "%s|%s\n", serial, custom_name);
    
    fclose(fp);
    print_log("INFO", "已保存设备名称: %s -> %s", serial, custom_name);
}
