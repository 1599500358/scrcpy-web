/**
 * 本地 WebSocket 服务器 + WebRTC 视频转发模块
 * 用于接收 scrcpy 视频流并通过 WebRTC DataChannel 转发到浏览器
 */

#include "local_video_relay.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#ifdef USE_WEBRTC
#include "webrtc_support.h"

// Windows 头文件
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <process.h>
#include <wincrypt.h>

// Avoid collision with scrcpy default adb tunnel local port range (27183-27199)
#define LOCAL_VIDEO_PORT_BASE 37183
#define LOCAL_VIDEO_PORT_TRY_COUNT 32
#define MAX_LOCAL_CLIENTS 8
#define VIDEO_BUFFER_SIZE (1024 * 1024)  // 1MB

// 本地 scrcpy 客户端连接
typedef struct {
    SOCKET video_socket;
    SOCKET control_socket;
    char serial[256];
    bool active;
    bool first_frame_seen;
    bool webrtc_stream_ready;
    uint8_t cached_sps[1024];
    int cached_sps_len;
    uint8_t cached_pps[1024];
    int cached_pps_len;
    DWORD last_keyframe_request_tick;
    int keyframe_fail_streak;   // 连续请求关键帧但未见 IDR 的次数
    int keyframe_reset_cycles;  // 已回退完整重置的轮数（防止无限重置循环）
    bool control_send_failed_logged; // 控制通道发送失败是否已告警（避免日志刷屏）
} LocalScrcpyClient;

// 控制连接发送串行化：触摸转发（WebRTC 回调线程）与关键帧请求（视频转发线程）
// 可能并发写同一控制 socket，必须保证单个 WebSocket 帧的完整发送不与其他帧交错
static CRITICAL_SECTION g_control_send_cs;
static bool g_control_send_cs_ready = false;

static LocalScrcpyClient local_clients[MAX_LOCAL_CLIENTS];
static int local_client_count = 0;
static SOCKET local_server_socket = INVALID_SOCKET;
static bool local_server_running = false;
static HANDLE local_server_thread = NULL;
static int local_server_port = 0;

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

// TCP_NODELAY 开关（LOCAL_CONTROL_TCP_NODELAY=0 可关闭，用于收益对照）
static bool local_relay_tcp_nodelay_enabled(void) {
    static int cached = -1;
    if (cached < 0) {
        const char* env = getenv("LOCAL_CONTROL_TCP_NODELAY");
        cached = (env && strcmp(env, "0") == 0) ? 0 : 1;
    }
    return cached != 0;
}

// 对接受成功的连接启用低延迟参数；失败仅提示一次，不影响连接建立
static void enable_low_latency_socket(SOCKET sock, const char* kind) {
    if (!local_relay_tcp_nodelay_enabled()) {
        return;
    }
    BOOL nodelay = 1;
    if (setsockopt(sock, IPPROTO_TCP, TCP_NODELAY,
                   (const char*)&nodelay, sizeof(nodelay)) == SOCKET_ERROR) {
        static bool nodelay_warned = false;
        if (!nodelay_warned) {
            print_log("WARN", "[LocalRelay] %s 连接设置 TCP_NODELAY 失败: wsa=%d（仅提示一次）",
                      kind, WSAGetLastError());
            nodelay_warned = true;
        }
    }
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
            local_clients[i].webrtc_stream_ready = false;
            local_clients[i].cached_sps_len = 0;
            local_clients[i].cached_pps_len = 0;
            local_clients[i].last_keyframe_request_tick = 0;
            local_clients[i].keyframe_fail_streak = 0;
            local_clients[i].keyframe_reset_cycles = 0;
            local_clients[i].control_send_failed_logged = false;
            if (i >= local_client_count) {
                local_client_count = i + 1;
            }
            return &local_clients[i];
        }
    }
    return NULL;
}

static bool socket_send_all(SOCKET sock, const uint8_t* data, int len) {
    int sent_total = 0;
    while (sent_total < len) {
        int n = send(sock, (const char*)data + sent_total, len - sent_total, 0);
        if (n <= 0) {
            return false;
        }
        sent_total += n;
    }
    return true;
}

// WebSocket 文本帧发送（服务器端不需要 mask）
// 头部和正文组合到同一缓冲区一次性发出，避免分离 send 产生的小包等待
static int ws_send_unmasked(SOCKET sock, const uint8_t* data, size_t len) {
    uint8_t header[10];
    int header_len = 2;

    header[0] = 0x81; // FIN + text frame

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

    // 控制消息通常很小，栈上缓冲即可；超长时退回堆分配
    uint8_t stack_buf[1024];
    uint8_t* combined = NULL;
    uint8_t* heap_buf = NULL;
    if (header_len + (int)len <= (int)sizeof(stack_buf)) {
        combined = stack_buf;
    } else {
        heap_buf = (uint8_t*)malloc(header_len + len);
        if (heap_buf) {
            combined = heap_buf;
        }
    }

    if (combined) {
        memcpy(combined, header, header_len);
        memcpy(combined + header_len, data, len);
        bool ok = socket_send_all(sock, combined, header_len + (int)len);
        if (heap_buf) {
            free(heap_buf);
        }
        if (!ok) {
            return -1;
        }
        return (int)len;
    }

    // 堆分配失败：退回分开发送，保证正确性
    if (!socket_send_all(sock, header, header_len)) {
        return -1;
    }
    if (!socket_send_all(sock, data, (int)len)) {
        return -1;
    }
    return (int)len;
}

// 控制连接的串行化发送：进入临界区后重新校验连接有效性，再完整发送单个帧
static bool control_socket_send_frame(LocalScrcpyClient* client, const uint8_t* data, size_t len) {
    if (!client || !g_control_send_cs_ready) {
        return false;
    }

    bool ok = false;
    EnterCriticalSection(&g_control_send_cs);
    if (client->active && client->control_socket != INVALID_SOCKET) {
        ok = ws_send_unmasked(client->control_socket, data, len) > 0;
        if (ok) {
            // 通道恢复后重新允许下一次失败的告警
            client->control_send_failed_logged = false;
        }
    }
    LeaveCriticalSection(&g_control_send_cs);
    return ok;
}

// 控制通道发送失败只告警一次，恢复后由 control_socket_send_frame 复位
static void log_control_send_failure_once(LocalScrcpyClient* client) {
    if (client && !client->control_send_failed_logged) {
        client->control_send_failed_logged = true;
        print_log("WARN", "[LocalRelay] 控制通道发送失败，等待通道恢复: %s（后续失败不再重复打印）",
                  client->serial);
    }
}

// 关闭控制连接时同样持锁，避免与正在进行的帧发送并发操作同一 socket
static void close_control_socket_locked(LocalScrcpyClient* client) {
    if (!client || client->control_socket == INVALID_SOCKET) {
        return;
    }
    if (g_control_send_cs_ready) {
        EnterCriticalSection(&g_control_send_cs);
        if (client->control_socket != INVALID_SOCKET) {
            closesocket(client->control_socket);
            client->control_socket = INVALID_SOCKET;
        }
        LeaveCriticalSection(&g_control_send_cs);
    } else {
        closesocket(client->control_socket);
        client->control_socket = INVALID_SOCKET;
    }
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

static bool recv_exact(SOCKET sock, void* buf, int len) {
    int total = 0;
    while (total < len) {
        int r = recv(sock, (char*)buf + total, len - total, 0);
        if (r <= 0) return false;
        total += r;
    }
    return true;
}

// 处理视频数据的 WebSocket 帧解析
static int recv_ws_frame(SOCKET sock, uint8_t* buffer, int buffer_size) {
    uint8_t header[2];
    if (!recv_exact(sock, header, 2)) {
        return -1; // 连接关闭或错误
    }

    bool fin = (header[0] & 0x80) != 0;
    int opcode = header[0] & 0x0F;
    bool masked = (header[1] & 0x80) != 0;
    int payload_len = header[1] & 0x7F;

    if (payload_len == 126) {
        uint8_t ext_len[2];
        if (!recv_exact(sock, ext_len, 2)) return -1;
        payload_len = (ext_len[0] << 8) | ext_len[1];
    } else if (payload_len == 127) {
        uint8_t ext_len[8];
        if (!recv_exact(sock, ext_len, 8)) return -1;
        uint32_t high = ((uint32_t)ext_len[0] << 24) | ((uint32_t)ext_len[1] << 16) | ((uint32_t)ext_len[2] << 8) | (uint32_t)ext_len[3];
        uint32_t low = ((uint32_t)ext_len[4] << 24) | ((uint32_t)ext_len[5] << 16) | ((uint32_t)ext_len[6] << 8) | (uint32_t)ext_len[7];
        if (high != 0 || low > (uint32_t)buffer_size) {
            print_log("WARN", "[LocalRelay] 64位帧长度超限: high=%u, low=%u, max=%d", high, low, buffer_size);
            return -1;
        }
        payload_len = (int)low;
    }

    if (payload_len < 0 || payload_len > buffer_size) {
        // 缓冲区不足或长度非法
        print_log("WARN", "[LocalRelay] 帧大小非法: %d > %d", payload_len, buffer_size);
        return -1;
    }

    uint8_t mask_key[4] = {0};
    if (masked) {
        if (!recv_exact(sock, mask_key, 4)) return -1;
    }

    // 读取负载数据
    if (!recv_exact(sock, buffer, payload_len)) {
        return -1;
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

static int find_start_code(const uint8_t* data, int len, int from, int* sc_len_out) {
    for (int i = from; i + 3 < len; i++) {
        if (data[i] == 0x00 && data[i + 1] == 0x00) {
            if (data[i + 2] == 0x01) {
                *sc_len_out = 3;
                return i;
            }
            if (i + 3 < len && data[i + 2] == 0x00 && data[i + 3] == 0x01) {
                *sc_len_out = 4;
                return i;
            }
        }
    }
    return -1;
}

static void update_h264_cache(LocalScrcpyClient* client, const uint8_t* data, int len, bool* has_idr) {
    *has_idr = false;
    int pos = 0;

    while (pos < len) {
        int sc_len = 0;
        int start = find_start_code(data, len, pos, &sc_len);
        if (start < 0) {
            break;
        }

        int nal_start = start + sc_len;
        if (nal_start >= len) {
            break;
        }

        int next_sc_len = 0;
        int next_start = find_start_code(data, len, nal_start, &next_sc_len);
        int nal_end = next_start >= 0 ? next_start : len;
        if (nal_end <= nal_start) {
            break;
        }

        uint8_t nal_type = data[nal_start] & 0x1F;
        int unit_len_with_sc = nal_end - start;

        if (nal_type == 7 && unit_len_with_sc <= (int)sizeof(client->cached_sps)) {
            memcpy(client->cached_sps, data + start, unit_len_with_sc);
            client->cached_sps_len = unit_len_with_sc;
        } else if (nal_type == 8 && unit_len_with_sc <= (int)sizeof(client->cached_pps)) {
            memcpy(client->cached_pps, data + start, unit_len_with_sc);
            client->cached_pps_len = unit_len_with_sc;
        } else if (nal_type == 5) {
            *has_idr = true;
        }

        if (next_start < 0) {
            break;
        }
        pos = next_start;
    }
}

// 轻量同步帧请求开关（SCRCPY_KEYFRAME_SYNC=0 可回退到旧的 resetVideo 方案）。
// requestSyncFrame 依赖 scrcpy-server 与 scrcpy.exe 同版本构建（控制协议类型 18）；
// 混用旧版 scrcpy-server 时必须置 0。
static bool sync_keyframe_enabled(void) {
    static int cached = -1;
    if (cached < 0) {
        const char* env = getenv("SCRCPY_KEYFRAME_SYNC");
        cached = (env && strcmp(env, "0") == 0) ? 0 : 1;
    }
    return cached != 0;
}

// 请求关键帧：优先使用轻量同步帧请求（不重置捕获/编码链路）；
// 连续 2 次（约 1 秒）未观察到 IDR 时允许一次完整重置；重复失败则停止重置循环
static void request_scrcpy_keyframe(LocalScrcpyClient* client) {
    if (!client || client->control_socket == INVALID_SOCKET) {
        return;
    }

    // 已连续多轮回退重置仍无 IDR：进入明确失败状态，停止请求避免重置循环
    if (client->keyframe_reset_cycles > 5) {
        return;
    }

    bool use_sync = sync_keyframe_enabled() && client->keyframe_fail_streak < 2;
    if (use_sync) {
        static const char* sync_msg = "{\"type\":\"control\",\"action\":\"requestSyncFrame\"}";
        if (control_socket_send_frame(client, (const uint8_t*)sync_msg, strlen(sync_msg)) > 0) {
            client->keyframe_fail_streak++;
            print_log("DEBUG", "[LocalRelay] 已请求同步帧: %s (streak=%d)",
                      client->serial, client->keyframe_fail_streak);
            return;
        }
        log_control_send_failure_once(client);
    }

    static const char* reset_msg = "{\"type\":\"control\",\"action\":\"resetVideo\"}";
    if (control_socket_send_frame(client, (const uint8_t*)reset_msg, strlen(reset_msg)) > 0) {
        if (use_sync) {
            // 同步帧路径未生效，回退完整重置
            client->keyframe_reset_cycles++;
            if (client->keyframe_reset_cycles == 6) {
                print_log("ERROR", "[LocalRelay] 关键帧恢复连续失败，已停止请求以避免重置循环，请重新选择设备: %s",
                          client->serial);
            } else {
                print_log("INFO", "[LocalRelay] 同步帧请求未见 IDR，已回退完整重置 (cycle=%d): %s",
                          client->keyframe_reset_cycles, client->serial);
            }
        }
        client->keyframe_fail_streak = 0;
    } else {
        log_control_send_failure_once(client);
    }
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
    // 轻量同步帧请求最短间隔 500ms；完整重置路径保持 1s，避免频繁触发编码重置
    const DWORD keyframe_request_interval = sync_keyframe_enabled() ? 500 : 1000;
    DWORD last_metrics_tick = GetTickCount();

    while (client->active && client->video_socket != INVALID_SOCKET) {
        int len = recv_ws_frame(client->video_socket, video_buffer, VIDEO_BUFFER_SIZE);
        if (len <= 0) {
            print_log("INFO", "[LocalRelay] 视频连接关闭: %s", client->serial);
            break;
        }

        frame_count++;

        bool has_idr = false;
        update_h264_cache(client, video_buffer, len, &has_idr);

        if (has_idr) {
            // 拿到 IDR 说明关键帧恢复已生效，复位失败计数
            client->keyframe_fail_streak = 0;
            client->keyframe_reset_cycles = 0;
        }

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
            if (!client->webrtc_stream_ready) {
                // 仅在拿到 SPS/PPS + IDR 后开始推流，确保浏览器端可立即起解码
                if (!has_idr || client->cached_sps_len <= 0 || client->cached_pps_len <= 0) {
                    drop_count++;
                    DWORD now = GetTickCount();
                    if (client->last_keyframe_request_tick == 0 ||
                        now - client->last_keyframe_request_tick >= keyframe_request_interval) {
                        request_scrcpy_keyframe(client);
                        client->last_keyframe_request_tick = now;
                    }
                    continue;
                }

                bool init_ok = webrtc_send_video(device_id, client->cached_sps, client->cached_sps_len)
                    && webrtc_send_video(device_id, client->cached_pps, client->cached_pps_len);
                bool first_ok = init_ok && webrtc_send_video(device_id, video_buffer, len);
                if (!first_ok) {
                    drop_count++;
                    if (drop_count < 5) {
                        print_log("WARN", "[LocalRelay] WebRTC 初始化首帧发送失败: %s", client->serial);
                    }
                    continue;
                }

                client->webrtc_stream_ready = true;
                print_log("INFO", "[LocalRelay] WebRTC 已发送 SPS/PPS+IDR，开始稳定推流: %s", client->serial);
                continue;
            }

            bool sent = webrtc_send_video(device_id, video_buffer, len);
            if (!sent) {
                // 发送失败（含水位居压触发）：按整帧失败处理，
                // 停止提交后续依赖帧，等待匹配配置的新 IDR 后再恢复
                drop_count++;
                client->webrtc_stream_ready = false;
                client->last_keyframe_request_tick = 0;
                print_log("WARN", "[LocalRelay] WebRTC 发送失败，等待新关键帧恢复: %s", client->serial);
            }
        } else {
            if (client->webrtc_stream_ready) {
                client->webrtc_stream_ready = false;
                print_log("INFO", "[LocalRelay] WebRTC 连接变化，等待关键帧恢复: %s", client->serial);
            }
            drop_count++;
            if (drop_count == 1 || drop_count % 100 == 0) {
                print_log("WARN", "[LocalRelay] WebRTC 未连接 (state=%d), 丢帧: %d", state, drop_count);
            }
        }

        // 每 2 秒向浏览器推送一次控制台侧链路指标（诊断面板数据源）
        DWORD now_tick = GetTickCount();
        if (now_tick - last_metrics_tick >= 2000) {
            last_metrics_tick = now_tick;
            char metrics_json[256];
            snprintf(metrics_json, sizeof(metrics_json),
                "{\"type\":\"consoleMetrics\",\"bufferedAmount\":%d,"
                "\"framesSent\":%llu,\"framesDropped\":%llu,\"relayDropped\":%d}",
                webrtc_get_buffered_amount(device_id),
                (unsigned long long)webrtc_get_frames_sent(device_id),
                (unsigned long long)webrtc_get_frames_dropped(device_id),
                drop_count);
            webrtc_send_text(device_id, metrics_json);
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

    print_log("INFO", "[LocalRelay] 本地服务器监听端口 %d", local_server_port);

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
                // 握手阶段设置短超时，避免异常连接长期阻塞监听线程
                int handshake_timeout_ms = 1500;
                setsockopt(client_sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&handshake_timeout_ms, sizeof(handshake_timeout_ms));
                setsockopt(client_sock, SOL_SOCKET, SO_SNDTIMEO, (const char*)&handshake_timeout_ms, sizeof(handshake_timeout_ms));

                char serial[256] = {0};
                WsConnType conn_type = WS_CONN_UNKNOWN;
                if (do_websocket_handshake(client_sock, serial, sizeof(serial), &conn_type)) {
                    // 握手成功后启用低延迟参数（TCP_NODELAY，可用环境变量关闭）
                    enable_low_latency_socket(client_sock,
                        conn_type == WS_CONN_CONTROL ? "control" : "video");

                    LocalScrcpyClient* client = find_local_client(serial);

                    // 连接类型必须先校验再占用槽位，防止未知类型握手泄漏槽位
                    if (conn_type == WS_CONN_UNKNOWN) {
                        print_log("WARN", "[LocalRelay] 未知连接类型，拒绝: %s", serial);
                        closesocket(client_sock);
                        continue;
                    }

                    if (!client) {
                        client = create_local_client(serial);
                    }

                    if (!client) {
                        print_log("WARN", "[LocalRelay] 客户端槽位不足，拒绝连接: %s", serial);
                        closesocket(client_sock);
                        continue;
                    }

                    if (conn_type == WS_CONN_CONTROL) {
                        close_control_socket_locked(client);
                        client->control_socket = client_sock;
                        print_log("INFO", "[LocalRelay] 控制连接已建立: %s", serial);
                    } else {
                        // 同 serial 视频重连：先 shutdown 唤醒可能阻塞在旧 socket
                        // recv 上的转发线程，再 close（跨线程 closesocket+句柄复用是 UB）
                        if (client->video_socket != INVALID_SOCKET) {
                            shutdown(client->video_socket, SD_BOTH);
                            closesocket(client->video_socket);
                            client->video_socket = INVALID_SOCKET;
                        }
                        client->video_socket = client_sock;
                        client->first_frame_seen = false;
                        client->webrtc_stream_ready = false;
                        client->cached_sps_len = 0;
                        client->cached_pps_len = 0;
                        client->last_keyframe_request_tick = 0;
                        client->keyframe_fail_streak = 0;
                        client->keyframe_reset_cycles = 0;
                        client->control_send_failed_logged = false;
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
    // 防重入：上一次 stop 未完全收尾（监听线程仍存活）时拒绝重 init，
    // 防止双线程同时 accept 同一监听 socket
    if (local_server_thread != NULL) {
        print_log("ERROR", "[LocalRelay] 上一监听线程尚未退出，拒绝重复初始化");
        return false;
    }
    // Winsock 已在主程序初始化，无需重复调用 WSAStartup
    if (!g_control_send_cs_ready) {
        InitializeCriticalSection(&g_control_send_cs);
        g_control_send_cs_ready = true;
    }

    local_server_port = 0;
    local_server_socket = INVALID_SOCKET;

    bool bound = false;
    int last_wsa_error = 0;

    for (int i = 0; i < LOCAL_VIDEO_PORT_TRY_COUNT; ++i) {
        int candidate_port = LOCAL_VIDEO_PORT_BASE + i;
        SOCKET candidate_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (candidate_socket == INVALID_SOCKET) {
            last_wsa_error = WSAGetLastError();
            print_log("ERROR", "[LocalRelay] 无法创建 socket: %d", last_wsa_error);
            return false;
        }

        // Windows 下启用独占绑定，避免多个进程同时监听同一端口
        BOOL exclusive = 1;
        if (setsockopt(candidate_socket, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                       (const char*)&exclusive, sizeof(exclusive)) == SOCKET_ERROR) {
            print_log("WARN", "[LocalRelay] SO_EXCLUSIVEADDRUSE 设置失败: %d", WSAGetLastError());
        }

        struct sockaddr_in server_addr;
        memset(&server_addr, 0, sizeof(server_addr));
        server_addr.sin_family = AF_INET;
        server_addr.sin_addr.s_addr = inet_addr("127.0.0.1");
        server_addr.sin_port = htons((u_short)candidate_port);

        if (bind(candidate_socket, (struct sockaddr*)&server_addr, sizeof(server_addr)) == SOCKET_ERROR) {
            last_wsa_error = WSAGetLastError();
            closesocket(candidate_socket);

            if (last_wsa_error == WSAEADDRINUSE || last_wsa_error == WSAEACCES) {
                continue;
            }
            print_log("ERROR", "[LocalRelay] bind 失败 (port=%d): %d", candidate_port, last_wsa_error);
            return false;
        }

        if (listen(candidate_socket, 5) == SOCKET_ERROR) {
            last_wsa_error = WSAGetLastError();
            print_log("ERROR", "[LocalRelay] listen 失败 (port=%d): %d", candidate_port, last_wsa_error);
            closesocket(candidate_socket);
            return false;
        }

        local_server_socket = candidate_socket;
        local_server_port = candidate_port;
        bound = true;
        break;
    }

    if (!bound) {
        print_log("ERROR", "[LocalRelay] 无法绑定可用端口，尝试范围: %d-%d, last_wsa=%d",
                  LOCAL_VIDEO_PORT_BASE,
                  LOCAL_VIDEO_PORT_BASE + LOCAL_VIDEO_PORT_TRY_COUNT - 1,
                  last_wsa_error);
        return false;
    }

    local_server_running = true;

    // 启动监听线程
    local_server_thread = (HANDLE)_beginthreadex(NULL, 0, local_server_listener, NULL, 0, NULL);
    if (!local_server_thread) {
        print_log("ERROR", "[LocalRelay] 无法创建监听线程");
        closesocket(local_server_socket);
        local_server_socket = INVALID_SOCKET;
        local_server_port = 0;
        local_server_running = false;
        return false;
    }

    if (local_server_port != LOCAL_VIDEO_PORT_BASE) {
        print_log("WARNING", "[LocalRelay] 首选端口 %d 被占用，已回退到端口 %d",
                  LOCAL_VIDEO_PORT_BASE, local_server_port);
    }
    print_log("SUCCESS", "[LocalRelay] 本地视频服务器已启动在端口 %d", local_server_port);
    return true;
}

// 停止本地服务器
void stop_local_video_relay() {
    local_server_running = false;

    // 关闭所有客户端连接。先 shutdown 唤醒阻塞在 recv 上的转发线程再 close，
    // 避免他线程 closesocket 阻塞 socket 的未定义行为与句柄复用串台
    for (int i = 0; i < local_client_count; i++) {
        if (local_clients[i].video_socket != INVALID_SOCKET) {
            shutdown(local_clients[i].video_socket, SD_BOTH);
            closesocket(local_clients[i].video_socket);
            local_clients[i].video_socket = INVALID_SOCKET;
        }
        close_control_socket_locked(&local_clients[i]);
        local_clients[i].active = false;
    }

    if (local_server_socket != INVALID_SOCKET) {
        closesocket(local_server_socket);
        local_server_socket = INVALID_SOCKET;
    }
    local_server_port = 0;

    if (local_server_thread) {
        // 监听线程最长可能阻塞在 1.5s 的握手里，等足 3s 防止僵尸监听线程
        DWORD wait_result = WaitForSingleObject(local_server_thread, 3000);
        if (wait_result == WAIT_TIMEOUT) {
            print_log("ERROR", "[LocalRelay] 监听线程 3s 未退出，存在僵尸线程风险");
        }
        CloseHandle(local_server_thread);
        local_server_thread = NULL;
    }

    // 临界区保留到进程退出：视频转发线程可能仍在使用，销毁中的 CS 不可重入

    // Winsock 清理由主程序处理
    print_log("INFO", "[LocalRelay] 本地视频服务器已停止");
}

// 获取本地服务器端口
int get_local_video_port() {
    if (local_server_port > 0) {
        return local_server_port;
    }
    return LOCAL_VIDEO_PORT_BASE;
}

bool is_local_video_relay_healthy() {
    if (!local_server_running || local_server_socket == INVALID_SOCKET) {
        return false;
    }

    // 监听线程必须存活；否则即使端口仍被内核保持，也无法处理握手
    if (!local_server_thread) {
        return false;
    }
    DWORD thread_wait = WaitForSingleObject(local_server_thread, 0);
    if (thread_wait == WAIT_OBJECT_0) {
        return false;
    }
    if (thread_wait == WAIT_FAILED) {
        return false;
    }

    int so_error = 0;
    int opt_len = sizeof(so_error);
    if (getsockopt(local_server_socket, SOL_SOCKET, SO_ERROR, (char*)&so_error, &opt_len) == SOCKET_ERROR) {
        return false;
    }
    return so_error == 0;
}

// 关闭指定设备的本地连接
void close_local_client(const char* serial) {
    LocalScrcpyClient* client = find_local_client(serial);
    if (client) {
        if (client->video_socket != INVALID_SOCKET) {
            shutdown(client->video_socket, SD_BOTH);
            closesocket(client->video_socket);
            client->video_socket = INVALID_SOCKET;
        }
        close_control_socket_locked(client);
        client->active = false;
        print_log("INFO", "[LocalRelay] 已关闭本地客户端: %s", serial);
    }
}

// 发送控制消息到 scrcpy（串行化，保证与其他线程的帧发送不交错）
bool send_control_to_scrcpy(const char* serial, const uint8_t* data, size_t len) {
    LocalScrcpyClient* client = find_local_client(serial);
    if (client) {
        return control_socket_send_frame(client, data, len);
    }
    return false;
}

// 供外部（如 requestKeyFrame 消息处理）调用的关键帧请求入口，复用内部重试/回退策略
bool request_device_keyframe(const char* serial) {
    LocalScrcpyClient* client = find_local_client(serial);
    if (!client || client->control_socket == INVALID_SOCKET) {
        return false;
    }
    request_scrcpy_keyframe(client);
    return true;
}

bool local_relay_sync_keyframe_enabled(void) {
    return sync_keyframe_enabled();
}

#else
// 非 WebRTC 模式的空实现
bool init_local_video_relay() { return true; }
void stop_local_video_relay() {}
int get_local_video_port() { return 0; }
bool is_local_video_relay_healthy() { return false; }
void close_local_client(const char* serial) { (void)serial; }
bool send_control_to_scrcpy(const char* serial, const uint8_t* data, size_t len) {
    (void)serial; (void)data; (void)len;
    return false;
}
bool request_device_keyframe(const char* serial) {
    (void)serial;
    return false;
}
bool local_relay_sync_keyframe_enabled(void) { return false; }
#endif // USE_WEBRTC
