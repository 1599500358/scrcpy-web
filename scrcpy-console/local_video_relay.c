/**
 * 本地 WebSocket 服务器 + WebRTC 视频转发模块
 * 用于接收 scrcpy 视频流并通过 WebRTC DataChannel 转发到浏览器
 */

#include "local_video_relay.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef USE_WEBRTC
#include "webrtc_support.h"

// Windows 头文件
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <process.h>
#include <wincrypt.h>

#define LOCAL_VIDEO_PORT 27183
#define MAX_LOCAL_CLIENTS 8
#define VIDEO_BUFFER_SIZE (1024 * 1024)  // 1MB

// 本地 scrcpy 客户端连接
typedef struct {
    SOCKET video_socket;
    SOCKET control_socket;
    char serial[256];
    bool active;
    bool first_frame_seen;
} LocalScrcpyClient;

static LocalScrcpyClient local_clients[MAX_LOCAL_CLIENTS];
static int local_client_count = 0;
static SOCKET local_server_socket = INVALID_SOCKET;
static bool local_server_running = false;
static HANDLE local_server_thread = NULL;

// 外部变量
extern void print_log(const char* level, const char* format, ...);
extern char client_id[64];

// 视频连接建立回调
static VideoConnectCallback g_video_connect_callback = NULL;

typedef enum {
    WS_CONN_UNKNOWN = 0,
    WS_CONN_VIDEO = 1,
    WS_CONN_CONTROL = 2
} WsConnType;

// 设置视频连接建立回调
void set_video_connect_callback(VideoConnectCallback callback) {
    g_video_connect_callback = callback;
}

// 查找本地客户端
static LocalScrcpyClient* find_local_client(const char* serial) {
    for (int i = 0; i < local_client_count; i++) {
        if (strcmp(local_clients[i].serial, serial) == 0 && local_clients[i].active) {
            return &local_clients[i];
        }
    }
    return NULL;
}

// 创建本地客户端
static LocalScrcpyClient* create_local_client(const char* serial) {
    if (local_client_count >= MAX_LOCAL_CLIENTS) {
        return NULL;
    }

    for (int i = 0; i < MAX_LOCAL_CLIENTS; i++) {
        if (!local_clients[i].active) {
            strncpy(local_clients[i].serial, serial, sizeof(local_clients[i].serial) - 1);
            local_clients[i].video_socket = INVALID_SOCKET;
            local_clients[i].control_socket = INVALID_SOCKET;
            local_clients[i].active = true;
            local_clients[i].first_frame_seen = false;
            if (i >= local_client_count) {
                local_client_count = i + 1;
            }
            return &local_clients[i];
        }
    }
    return NULL;
}

// WebSocket 帧发送（服务器端不需要 mask）
static int ws_send_unmasked(SOCKET sock, const uint8_t* data, size_t len) {
    uint8_t header[10];
    int header_len = 2;

    header[0] = 0x82; // FIN + binary frame

    if (len < 126) {
        header[1] = (uint8_t)len;
    } else if (len < 65536) {
        header[1] = 126;
        header[2] = (len >> 8) & 0xFF;
        header[3] = len & 0xFF;
        header_len = 4;
    } else {
        header[1] = 127;
        for (int i = 0; i < 8; i++) {
            header[2 + i] = (len >> ((7 - i) * 8)) & 0xFF;
        }
        header_len = 10;
    }

    if (send(sock, (char*)header, header_len, 0) < header_len) {
        return -1;
    }

    return send(sock, (char*)data, (int)len, 0);
}

static int recv_http_headers(SOCKET sock, char* request, int request_size) {
    int total = 0;
    while (total < request_size - 1) {
        int r = recv(sock, request + total, request_size - 1 - total, 0);
        if (r <= 0) {
            if (total > 0) {
                request[total] = '\0';
                return total;
            }
            return r;
        }
        total += r;
        request[total] = '\0';
        if (strstr(request, "\r\n\r\n")) {
            return total;
        }
    }
    request[total] = '\0';
    return total;
}

static bool extract_header_value(const char* request, const char* header_name,
                                 char* out, int out_size) {
    const char* start = strstr(request, header_name);
    if (!start) {
        return false;
    }
    start += strlen(header_name);
    while (*start == ' ' || *start == '\t') {
        start++;
    }
    const char* end = strstr(start, "\r\n");
    if (!end) {
        return false;
    }
    int len = (int)(end - start);
    while (len > 0 && (start[len - 1] == ' ' || start[len - 1] == '\t')) {
        len--;
    }
    if (len <= 0 || len >= out_size) {
        return false;
    }
    memcpy(out, start, len);
    out[len] = '\0';
    return true;
}

static bool build_websocket_accept(const char* ws_key, char* accept_out, int accept_size) {
    static const char* ws_guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    char key_with_guid[256];
    snprintf(key_with_guid, sizeof(key_with_guid), "%s%s", ws_key, ws_guid);

    HCRYPTPROV hProv = 0;
    HCRYPTHASH hHash = 0;
    bool ok = false;
    BYTE hash[20];
    DWORD hash_len = sizeof(hash);

    if (!CryptAcquireContextA(&hProv, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) {
        if (!CryptAcquireContextA(&hProv, NULL, NULL, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT)) {
            return false;
        }
    }
    if (!CryptCreateHash(hProv, CALG_SHA1, 0, 0, &hHash)) {
        CryptReleaseContext(hProv, 0);
        return false;
    }
    if (!CryptHashData(hHash, (const BYTE*)key_with_guid, (DWORD)strlen(key_with_guid), 0)) {
        goto cleanup;
    }
    if (!CryptGetHashParam(hHash, HP_HASHVAL, hash, &hash_len, 0)) {
        goto cleanup;
    }

    DWORD b64_len = 0;
    if (!CryptBinaryToStringA(hash, hash_len, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, NULL, &b64_len)) {
        goto cleanup;
    }
    if ((int)b64_len > accept_size) {
        goto cleanup;
    }
    if (!CryptBinaryToStringA(hash, hash_len, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, accept_out, &b64_len)) {
        goto cleanup;
    }
    ok = true;

cleanup:
    if (hHash) {
        CryptDestroyHash(hHash);
    }
    if (hProv) {
        CryptReleaseContext(hProv, 0);
    }
    return ok;
}

// WebSocket 握手
static bool do_websocket_handshake(SOCKET sock, char* serial_out, int serial_size, WsConnType* conn_type_out) {
    char request[4096];
    int received = recv_http_headers(sock, request, sizeof(request));
    if (received <= 0) {
        int err = WSAGetLastError();
        if (err == 0) {
            print_log("INFO", "[LocalRelay] 连接在发送握手前已关闭");
        } else {
            print_log("WARN", "[LocalRelay] 握手读取请求头失败: wsa=%d", err);
        }
        return false;
    }
    if (!strstr(request, "\r\n\r\n")) {
        print_log("WARN", "[LocalRelay] 握手请求不完整(%d字节): %.200s", received, request);
        return false;
    }

    // 解析 GET 请求路径获取 serial
    // GET /?type=scrcpy&serial=xxx HTTP/1.1
    char* serial_start = strstr(request, "serial=");
    if (serial_start) {
        serial_start += 7;
        char* serial_end = serial_start;
        while (*serial_end && *serial_end != ' ' && *serial_end != '&' && *serial_end != '\r' && *serial_end != '\n') {
            serial_end++;
        }
        int len = (int)(serial_end - serial_start);
        if (len >= serial_size) {
            len = serial_size - 1;
        }
        strncpy(serial_out, serial_start, len);
        serial_out[len] = '\0';
    } else {
        print_log("WARN", "[LocalRelay] 握手请求缺少 serial 参数: %s", request);
        return false;
    }

    WsConnType conn_type = WS_CONN_UNKNOWN;
    if (strstr(request, "type=control") != NULL) {
        conn_type = WS_CONN_CONTROL;
    } else if (strstr(request, "type=scrcpy") != NULL) {
        conn_type = WS_CONN_VIDEO;
    }
    if (conn_type_out) {
        *conn_type_out = conn_type;
    }

    char ws_key[256];
    if (!extract_header_value(request, "Sec-WebSocket-Key:", ws_key, sizeof(ws_key))) {
        print_log("WARN", "[LocalRelay] 握手缺少 Sec-WebSocket-Key");
        return false;
    }

    char accept_key[128];
    if (!build_websocket_accept(ws_key, accept_key, sizeof(accept_key))) {
        print_log("WARN", "[LocalRelay] 计算 Sec-WebSocket-Accept 失败");
        return false;
    }

    char response[512];
    snprintf(response, sizeof(response),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n"
        "\r\n",
        accept_key);

    if (send(sock, response, (int)strlen(response), 0) <= 0) {
        print_log("WARN", "[LocalRelay] 握手响应发送失败: wsa=%d", WSAGetLastError());
        return false;
    }

    print_log("INFO", "[LocalRelay] WebSocket 握手成功，serial: %s, type=%s",
              serial_out,
              conn_type == WS_CONN_CONTROL ? "control" :
              (conn_type == WS_CONN_VIDEO ? "scrcpy" : "unknown"));

    return true;
}

// 处理视频数据的 WebSocket 帧解析
static int recv_ws_frame(SOCKET sock, uint8_t* buffer, int buffer_size) {
    uint8_t header[2];
    int received = recv(sock, (char*)header, 2, 0);
    if (received <= 0) {
        return -1; // 连接关闭或错误
    }

    bool fin = (header[0] & 0x80) != 0;
    int opcode = header[0] & 0x0F;
    bool masked = (header[1] & 0x80) != 0;
    int payload_len = header[1] & 0x7F;

    if (payload_len == 126) {
        uint8_t ext_len[2];
        if (recv(sock, (char*)ext_len, 2, 0) <= 0) return -1;
        payload_len = (ext_len[0] << 8) | ext_len[1];
    } else if (payload_len == 127) {
        uint8_t ext_len[8];
        if (recv(sock, (char*)ext_len, 8, 0) <= 0) return -1;
        payload_len = 0;
        for (int i = 0; i < 8; i++) {
            payload_len = (payload_len << 8) | ext_len[i];
        }
    }

    uint8_t mask_key[4] = {0};
    if (masked) {
        if (recv(sock, (char*)mask_key, 4, 0) <= 0) return -1;
    }

    if (payload_len > buffer_size) {
        // 缓冲区不足，需要分段读取
        print_log("WARN", "[LocalRelay] 帧太大: %d > %d", payload_len, buffer_size);
        return -1;
    }

    // 读取负载数据
    int total_received = 0;
    while (total_received < payload_len) {
        int r = recv(sock, (char*)buffer + total_received, payload_len - total_received, 0);
        if (r <= 0) return -1;
        total_received += r;
    }

    // 解除 mask
    if (masked) {
        for (int i = 0; i < payload_len; i++) {
            buffer[i] ^= mask_key[i % 4];
        }
    }

    // 只处理二进制帧
    if (opcode == 0x08) { // Close frame
        return -1;
    }

    return payload_len;
}

// 视频数据转发线程
static unsigned __stdcall video_relay_thread(void* param) {
    LocalScrcpyClient* client = (LocalScrcpyClient*)param;
    uint8_t* video_buffer = (uint8_t*)malloc(VIDEO_BUFFER_SIZE);

    if (!video_buffer) {
        print_log("ERROR", "[LocalRelay] 无法分配视频缓冲区");
        return 1;
    }

    print_log("INFO", "[LocalRelay] 视频转发线程启动: %s", client->serial);

    int frame_count = 0;
    int drop_count = 0;

    while (client->active && client->video_socket != INVALID_SOCKET) {
        int len = recv_ws_frame(client->video_socket, video_buffer, VIDEO_BUFFER_SIZE);
        if (len <= 0) {
            print_log("INFO", "[LocalRelay] 视频连接关闭: %s", client->serial);
            break;
        }

        frame_count++;

        if (!client->first_frame_seen) {
            client->first_frame_seen = true;
            if (g_video_connect_callback) {
                g_video_connect_callback(client->serial);
            }
        }

        // 通过 WebRTC DataChannel 发送
        char device_id[512];
        extern char client_id[64];
        snprintf(device_id, sizeof(device_id), "%s:%s", client_id, client->serial);

        WebRTCState state = webrtc_get_state(device_id);
        if (state == WEBRTC_STATE_CONNECTED) {
            bool sent = webrtc_send_video(device_id, video_buffer, len);
            if (!sent) {
                drop_count++;
                if (drop_count < 5) {
                    print_log("WARN", "[LocalRelay] WebRTC 发送失败: %s", client->serial);
                }
            }
        } else {
            drop_count++;
            if (drop_count == 1 || drop_count % 100 == 0) {
                print_log("WARN", "[LocalRelay] WebRTC 未连接 (state=%d), 丢帧: %d", state, drop_count);
            }
        }

        // 每 100 帧打印一次统计
        if (frame_count % 100 == 0) {
            print_log("DEBUG", "[LocalRelay] %s: 已处理 %d 帧, 丢弃 %d 帧", client->serial, frame_count, drop_count);
        }
    }

    free(video_buffer);
    print_log("INFO", "[LocalRelay] 视频转发线程结束: %s, 总帧数: %d, 丢弃: %d", client->serial, frame_count, drop_count);
    return 0;
}

// 本地服务器监听线程
static unsigned __stdcall local_server_listener(void* param) {
    (void)param;

    print_log("INFO", "[LocalRelay] 本地服务器监听端口 %d", LOCAL_VIDEO_PORT);

    while (local_server_running) {
        fd_set read_fds;
        FD_ZERO(&read_fds);
        FD_SET(local_server_socket, &read_fds);

        struct timeval timeout;
        timeout.tv_sec = 1;
        timeout.tv_usec = 0;

        int result = select(0, &read_fds, NULL, NULL, &timeout);
        if (result > 0 && FD_ISSET(local_server_socket, &read_fds)) {
            struct sockaddr_in client_addr;
            int addr_len = sizeof(client_addr);
            SOCKET client_sock = accept(local_server_socket, (struct sockaddr*)&client_addr, &addr_len);

            if (client_sock != INVALID_SOCKET) {
                char serial[256] = {0};
                WsConnType conn_type = WS_CONN_UNKNOWN;
                if (do_websocket_handshake(client_sock, serial, sizeof(serial), &conn_type)) {
                    LocalScrcpyClient* client = find_local_client(serial);
                    if (!client) {
                        client = create_local_client(serial);
                    }

                    if (!client) {
                        print_log("WARN", "[LocalRelay] 客户端槽位不足，拒绝连接: %s", serial);
                        closesocket(client_sock);
                        continue;
                    }

                    if (conn_type == WS_CONN_UNKNOWN) {
                        print_log("WARN", "[LocalRelay] 未知连接类型，拒绝: %s", serial);
                        closesocket(client_sock);
                        continue;
                    }

                    if (conn_type == WS_CONN_CONTROL) {
                        if (client->control_socket != INVALID_SOCKET) {
                            closesocket(client->control_socket);
                        }
                        client->control_socket = client_sock;
                        print_log("INFO", "[LocalRelay] 控制连接已建立: %s", serial);
                    } else {
                        if (client->video_socket != INVALID_SOCKET) {
                            closesocket(client->video_socket);
                        }
                        client->video_socket = client_sock;
                        client->first_frame_seen = false;
                        print_log("INFO", "[LocalRelay] 视频连接已建立: %s", serial);

                        // 启动视频转发线程
                        HANDLE thread = (HANDLE)_beginthreadex(NULL, 0, video_relay_thread, client, 0, NULL);
                        if (thread) {
                            CloseHandle(thread);
                        }
                    }
                } else {
                    closesocket(client_sock);
                }
            }
        }
    }

    return 0;
}

// 初始化本地服务器
bool init_local_video_relay() {
    // Winsock 已在主程序初始化，无需重复调用 WSAStartup

    local_server_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (local_server_socket == INVALID_SOCKET) {
        print_log("ERROR", "[LocalRelay] 无法创建 socket");
        return false;
    }

    // 允许地址重用
    int reuse = 1;
    setsockopt(local_server_socket, SOL_SOCKET, SO_REUSEADDR, (char*)&reuse, sizeof(reuse));

    struct sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    server_addr.sin_port = htons(LOCAL_VIDEO_PORT);

    if (bind(local_server_socket, (struct sockaddr*)&server_addr, sizeof(server_addr)) == SOCKET_ERROR) {
        print_log("ERROR", "[LocalRelay] bind 失败: %d", WSAGetLastError());
        closesocket(local_server_socket);
        return false;
    }

    if (listen(local_server_socket, 5) == SOCKET_ERROR) {
        print_log("ERROR", "[LocalRelay] listen 失败");
        closesocket(local_server_socket);
        return false;
    }

    local_server_running = true;

    // 启动监听线程
    local_server_thread = (HANDLE)_beginthreadex(NULL, 0, local_server_listener, NULL, 0, NULL);
    if (!local_server_thread) {
        print_log("ERROR", "[LocalRelay] 无法创建监听线程");
        closesocket(local_server_socket);
        return false;
    }

    print_log("SUCCESS", "[LocalRelay] 本地视频服务器已启动在端口 %d", LOCAL_VIDEO_PORT);
    return true;
}

// 停止本地服务器
void stop_local_video_relay() {
    local_server_running = false;

    // 关闭所有客户端连接
    for (int i = 0; i < local_client_count; i++) {
        if (local_clients[i].video_socket != INVALID_SOCKET) {
            closesocket(local_clients[i].video_socket);
        }
        if (local_clients[i].control_socket != INVALID_SOCKET) {
            closesocket(local_clients[i].control_socket);
        }
        local_clients[i].active = false;
    }

    if (local_server_socket != INVALID_SOCKET) {
        closesocket(local_server_socket);
        local_server_socket = INVALID_SOCKET;
    }

    if (local_server_thread) {
        WaitForSingleObject(local_server_thread, 1000);
        CloseHandle(local_server_thread);
        local_server_thread = NULL;
    }

    // Winsock 清理由主程序处理
    print_log("INFO", "[LocalRelay] 本地视频服务器已停止");
}

// 获取本地服务器端口
int get_local_video_port() {
    return LOCAL_VIDEO_PORT;
}

// 关闭指定设备的本地连接
void close_local_client(const char* serial) {
    LocalScrcpyClient* client = find_local_client(serial);
    if (client) {
        if (client->video_socket != INVALID_SOCKET) {
            closesocket(client->video_socket);
            client->video_socket = INVALID_SOCKET;
        }
        if (client->control_socket != INVALID_SOCKET) {
            closesocket(client->control_socket);
            client->control_socket = INVALID_SOCKET;
        }
        client->active = false;
        print_log("INFO", "[LocalRelay] 已关闭本地客户端: %s", serial);
    }
}

// 发送控制消息到 scrcpy
bool send_control_to_scrcpy(const char* serial, const uint8_t* data, size_t len) {
    LocalScrcpyClient* client = find_local_client(serial);
    if (client && client->control_socket != INVALID_SOCKET) {
        return ws_send_unmasked(client->control_socket, data, len) > 0;
    }
    return false;
}

#else
// 非 WebRTC 模式的空实现
bool init_local_video_relay() { return true; }
void stop_local_video_relay() {}
int get_local_video_port() { return 0; }
void close_local_client(const char* serial) { (void)serial; }
bool send_control_to_scrcpy(const char* serial, const uint8_t* data, size_t len) {
    (void)serial; (void)data; (void)len;
    return false;
}
#endif // USE_WEBRTC
