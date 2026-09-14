/**
 * WebRTC 支持模块实现
 * 使用 libdatachannel 库
 */

#include "webrtc_support.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// libdatachannel 头文件
// 需要将 rtc.h 放到 include 路径或当前目录
#ifdef USE_WEBRTC
#include <rtc/rtc.h>
#endif

#define MAX_DEVICES 32
#define MAX_ICE_CANDIDATES 128
#define SDP_BUFFER_SIZE 8192
#define VIDEO_CHUNK_MAGIC 0xA5
#define VIDEO_CHUNK_HEADER_SIZE 6
#define VIDEO_CHUNK_PAYLOAD_MAX (60 * 1024)

// 发送水位默认预算：original 档 8 Mbps × 100ms / 8 = 100KB。
// 启动设备时由控制台按实际档位码率调用 webrtc_set_send_budget() 覆盖
#define DEFAULT_SEND_BUDGET_BYTES (100 * 1024)

// 设备 WebRTC 连接信息
typedef struct {
    char device_id[256];
    int pc;  // PeerConnection ID (libdatachannel)
    int dc;  // DataChannel ID
    WebRTCState state;
    uint32_t next_frame_seq;
    uint64_t frames_sent;
    uint64_t frames_dropped;
    size_t send_budget_bytes;   // DataChannel 发送水位预算（字节），0 表示不限制
    char local_sdp[SDP_BUFFER_SIZE];
    char remote_sdp[SDP_BUFFER_SIZE];
    char ice_candidates[MAX_ICE_CANDIDATES][512];
    int ice_count;
} DeviceConnection;

// 全局状态
static bool g_initialized = false;
static WebRTCConfig g_config = {0};
static DeviceConnection g_connections[MAX_DEVICES] = {0};
static int g_connection_count = 0;
static WebRTCStateCallback g_state_callback = NULL;
static WebRTCMessageCallback g_message_callback = NULL;
static WebRTCDataMessageCallback g_data_message_callback = NULL;
static size_t g_send_budget_bytes = DEFAULT_SEND_BUDGET_BYTES;

// 查找设备连接
static DeviceConnection* find_connection(const char* device_id) {
    for (int i = 0; i < g_connection_count; i++) {
        if (strcmp(g_connections[i].device_id, device_id) == 0) {
            return &g_connections[i];
        }
    }
    return NULL;
}

// 创建新的设备连接
static DeviceConnection* create_connection(const char* device_id) {
    if (g_connection_count >= MAX_DEVICES) {
        return NULL;
    }

    DeviceConnection* conn = &g_connections[g_connection_count];
    memset(conn, 0, sizeof(DeviceConnection));
    strncpy(conn->device_id, device_id, sizeof(conn->device_id) - 1);
    conn->pc = -1;
    conn->dc = -1;
    conn->state = WEBRTC_STATE_DISCONNECTED;
    conn->next_frame_seq = 1;
    conn->send_budget_bytes = g_send_budget_bytes;
    g_connection_count++;

    return conn;
}

// 按 libdatachannel 的 URI 规则对 userinfo 组件做百分号编码（保留字符必须转义）
static bool percent_encode_userinfo(const char* input, char* output, size_t output_size) {
    static const char* hex = "0123456789ABCDEF";
    size_t out = 0;
    for (const char* p = input; p && *p; p++) {
        unsigned char c = (unsigned char)*p;
        bool unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                          (c >= '0' && c <= '9') || c == '-' || c == '.' ||
                          c == '_' || c == '~';
        if (unreserved) {
            if (out + 1 >= output_size) return false;
            output[out++] = (char)c;
        } else {
            if (out + 3 >= output_size) return false;
            output[out++] = '%';
            output[out++] = hex[(c >> 4) & 0xF];
            output[out++] = hex[c & 0xF];
        }
    }
    output[out] = '\0';
    return true;
}

#ifdef USE_WEBRTC

// DataChannel 打开回调
static void on_dc_open(int dc, void* ptr) {
    DeviceConnection* conn = (DeviceConnection*)rtcGetUserPointer(dc);
    if (conn) {
        conn->state = WEBRTC_STATE_CONNECTED;
        printf("[WebRTC] DataChannel 已打开: %s\n", conn->device_id);
        if (g_state_callback) {
            g_state_callback(conn->device_id, WEBRTC_STATE_CONNECTED);
        }
    }
}

// DataChannel 关闭回调
static void on_dc_closed(int dc, void* ptr) {
    DeviceConnection* conn = (DeviceConnection*)rtcGetUserPointer(dc);
    if (conn) {
        conn->state = WEBRTC_STATE_DISCONNECTED;
        printf("[WebRTC] DataChannel 已关闭: %s\n", conn->device_id);
        if (g_state_callback) {
            g_state_callback(conn->device_id, WEBRTC_STATE_DISCONNECTED);
        }
    }
}

// DataChannel 消息回调（接收来自 Web 客户端的控制消息）
static void on_dc_message(int dc, const char* message, int size, void* ptr) {
    (void)ptr;
    DeviceConnection* conn = (DeviceConnection*)rtcGetUserPointer(dc);
    if (!conn || !message) {
        return;
    }

    size_t payload_len = 0;
    // libdatachannel: 文本消息可能返回 size=-1（以 '\0' 结尾）
    if (size < 0) {
        payload_len = strlen(message);
    } else {
        payload_len = (size_t)size;
    }
    if (payload_len == 0) {
        return;
    }

    if (g_data_message_callback) {
        g_data_message_callback(conn->device_id, (const uint8_t*)message, payload_len);
    }
}

// PeerConnection 本地描述回调（生成 Offer 后触发）
static void on_local_description(int pc, const char* sdp, const char* type, void* ptr) {
    printf("[WebRTC] on_local_description 回调被触发\n");
    printf("[WebRTC] SDP type: %s\n", type ? type : "NULL");

    DeviceConnection* conn = (DeviceConnection*)rtcGetUserPointer(pc);
    printf("[WebRTC] UserPointer: %p\n", (void*)conn);

    if (conn && sdp) {
        printf("[WebRTC] device_id: %s\n", conn->device_id);
        strncpy(conn->local_sdp, sdp, SDP_BUFFER_SIZE - 1);

        // 转义 SDP 字符串中的特殊字符（换行符等）
        char* escaped_sdp = (char*)malloc(SDP_BUFFER_SIZE * 2);
        if (!escaped_sdp) {
            printf("[WebRTC] 内存分配失败\n");
            return;
        }

        const char* src = sdp;
        char* dst = escaped_sdp;
        while (*src && (dst - escaped_sdp) < (SDP_BUFFER_SIZE * 2 - 2)) {
            switch (*src) {
                case '\n':
                    *dst++ = '\\';
                    *dst++ = 'n';
                    break;
                case '\r':
                    *dst++ = '\\';
                    *dst++ = 'r';
                    break;
                case '"':
                    *dst++ = '\\';
                    *dst++ = '"';
                    break;
                case '\\':
                    *dst++ = '\\';
                    *dst++ = '\\';
                    break;
                default:
                    *dst++ = *src;
            }
            src++;
        }
        *dst = '\0';

        printf("[WebRTC] SDP 长度: %zu, 转义后长度: %zu\n", strlen(sdp), strlen(escaped_sdp));

        // 构造 JSON 格式的 Offer 消息
        char message[SDP_BUFFER_SIZE * 2 + 512];
        snprintf(message, sizeof(message),
            "{\"type\":\"webrtc-offer\",\"deviceId\":\"%s\",\"sdp\":{\"type\":\"offer\",\"sdp\":\"%s\"}}",
            conn->device_id, escaped_sdp);

        free(escaped_sdp);

        // 发送 Offer 到信令服务器
        printf("[WebRTC] 调用消息回调发送 Offer...\n");
        if (g_message_callback) {
            g_message_callback(conn->device_id, message);
            printf("[WebRTC] Offer 已通过回调发送\n");
        } else {
            printf("[WebRTC] 错误: 消息回调未设置!\n");
        }

        printf("[WebRTC] 已生成本地描述 (Offer)\n");
    } else {
        printf("[WebRTC] 错误: conn=%p, sdp=%p\n", (void*)conn, (void*)sdp);
    }
}

// ICE Candidate 回调
static void on_ice_candidate(int pc, const char* candidate, const char* mid, void* ptr) {
    printf("[WebRTC] on_ice_candidate 回调被触发\n");

    DeviceConnection* conn = (DeviceConnection*)rtcGetUserPointer(pc);
    if (conn && candidate) {
        printf("[WebRTC] ICE candidate for device: %s\n", conn->device_id);

        // 缓存 ICE candidate
        if (conn->ice_count < MAX_ICE_CANDIDATES) {
            strncpy(conn->ice_candidates[conn->ice_count], candidate, 511);
            conn->ice_count++;
        }

        // 转义 candidate 字符串
        char escaped_candidate[1024];
        const char* src = candidate;
        char* dst = escaped_candidate;
        while (*src && (dst - escaped_candidate) < sizeof(escaped_candidate) - 2) {
            switch (*src) {
                case '\n': *dst++ = '\\'; *dst++ = 'n'; break;
                case '\r': *dst++ = '\\'; *dst++ = 'r'; break;
                case '"': *dst++ = '\\'; *dst++ = '"'; break;
                case '\\': *dst++ = '\\'; *dst++ = '\\'; break;
                default: *dst++ = *src;
            }
            src++;
        }
        *dst = '\0';

        // 构造 ICE candidate 消息
        char message[2048];
        snprintf(message, sizeof(message),
            "{\"type\":\"webrtc-ice-candidate\",\"deviceId\":\"%s\",\"candidate\":{\"candidate\":\"%s\",\"sdpMid\":\"%s\"},\"from\":\"console\"}",
            conn->device_id, escaped_candidate, mid ? mid : "0");

        // 发送 ICE candidate 到信令服务器
        if (g_message_callback) {
            g_message_callback(conn->device_id, message);
            printf("[WebRTC] ICE candidate 已发送\n");
        }
    }
}

// PeerConnection 状态改变回调
static void on_state_change(int pc, rtcState state, void* ptr) {
    DeviceConnection* conn = (DeviceConnection*)rtcGetUserPointer(pc);
    if (conn) {
        switch (state) {
            case RTC_CONNECTING:
                conn->state = WEBRTC_STATE_CONNECTING;
                break;
            case RTC_CONNECTED:
                conn->state = WEBRTC_STATE_CONNECTED;
                break;
            case RTC_DISCONNECTED:
            case RTC_FAILED:
                conn->state = WEBRTC_STATE_DISCONNECTED;
                break;
            default:
                break;
        }

        if (g_state_callback) {
            g_state_callback(conn->device_id, conn->state);
        }

        printf("[WebRTC] 状态改变: %d\n", state);
    }
}

#endif // USE_WEBRTC

bool webrtc_init(const WebRTCConfig* config) {
#ifdef USE_WEBRTC
    if (g_initialized) {
        return true;
    }

    if (config) {
        memcpy(&g_config, config, sizeof(WebRTCConfig));
    }

    // 配置日志级别
    rtcInitLogger(RTC_LOG_WARNING, NULL);

    g_initialized = true;
    printf("[WebRTC] 初始化成功\n");
    return true;
#else
    printf("[WebRTC] 未启用 WebRTC 支持 (编译时未定义 USE_WEBRTC)\n");
    return false;
#endif
}

void webrtc_cleanup(void) {
#ifdef USE_WEBRTC
    // 关闭所有连接
    for (int i = 0; i < g_connection_count; i++) {
        if (g_connections[i].pc >= 0) {
            rtcClosePeerConnection(g_connections[i].pc);
        }
    }

    g_connection_count = 0;
    g_initialized = false;
    printf("[WebRTC] 已清理\n");
#endif
}

char* webrtc_create_offer(const char* device_id) {
#ifdef USE_WEBRTC
    if (!g_initialized || !device_id) {
        return NULL;
    }

    DeviceConnection* conn = find_connection(device_id);
    if (!conn) {
        conn = create_connection(device_id);
    }
    if (!conn) {
        return NULL;
    }

    // 配置 ICE 服务器
    rtcConfiguration conf;
    memset(&conf, 0, sizeof(conf));

    // 设置 STUN/TURN 服务器 (使用静态数组)
    static const char* ice_servers[4] = {NULL, NULL, NULL, NULL};
    static char stun_url[256] = {0};
    // 结构体字段上限：username/password 各 127 字节、host 255 字节，百分号编码后
    // URI 最长约 3*127*2 + 255 + 固定开销 ≈ 1040 字节，1280 缓冲不会截断
    static char turn_url[1280] = {0};

    int server_count = 0;

    // STUN 服务器
    if (g_config.stun_server[0]) {
        snprintf(stun_url, sizeof(stun_url), "stun:%s", g_config.stun_server);
    } else {
        strncpy(stun_url, "stun:stun.l.google.com:19302", sizeof(stun_url) - 1);
    }
    ice_servers[server_count++] = stun_url;

    // TURN 服务器（如果配置了）
    // libdatachannel 要求标准 TURN URI：turn:<user>:<pass>@<host>[:port][?transport=udp]，
    // 凭据中的保留字符需百分号编码；空格拼接格式无法通过解析
    if (g_config.turn_server[0] && g_config.turn_username[0]) {
        char user_enc[512] = {0};
        char pass_enc[512] = {0};
        if (!percent_encode_userinfo(g_config.turn_username, user_enc, sizeof(user_enc)) ||
            !percent_encode_userinfo(g_config.turn_password, pass_enc, sizeof(pass_enc))) {
            printf("[WebRTC] TURN 凭据编码失败，忽略 TURN 配置\n");
        } else {
            int url_len = snprintf(turn_url, sizeof(turn_url), "turn:%s:%s@%s?transport=udp",
                user_enc, pass_enc, g_config.turn_server);
            if (url_len < 0 || url_len >= (int)sizeof(turn_url)) {
                // 截断会产生非法 URI 导致 TURN 静默失效，必须显式失败
                printf("[WebRTC] TURN URI 构建超限 (len=%d)，忽略 TURN 配置\n", url_len);
            } else {
                ice_servers[server_count++] = turn_url;
            }
        }
    }

    conf.iceServers = ice_servers;
    conf.iceServersCount = server_count;

    // 创建 PeerConnection
    conn->pc = rtcCreatePeerConnection(&conf);
    if (conn->pc < 0) {
        printf("[WebRTC] 创建 PeerConnection 失败\n");
        return NULL;
    }

    // 设置 User Pointer，让回调能获取到连接信息
    // 必须在设置回调和创建 DataChannel 之前设置
    rtcSetUserPointer(conn->pc, conn);

    // 设置回调
    rtcSetLocalDescriptionCallback(conn->pc, on_local_description);
    rtcSetLocalCandidateCallback(conn->pc, on_ice_candidate);
    rtcSetStateChangeCallback(conn->pc, on_state_change);

    // 创建 DataChannel (使用简化 API)
    conn->dc = rtcCreateDataChannel(conn->pc, "video");
    if (conn->dc < 0) {
        printf("[WebRTC] 创建 DataChannel 失败\n");
        rtcClosePeerConnection(conn->pc);
        conn->pc = -1;
        return NULL;
    }

    // 设置 DataChannel 的 User Pointer
    rtcSetUserPointer(conn->dc, conn);

    // 设置 DataChannel 回调
    rtcSetOpenCallback(conn->dc, on_dc_open);
    rtcSetClosedCallback(conn->dc, on_dc_closed);
    rtcSetMessageCallback(conn->dc, on_dc_message);

    conn->state = WEBRTC_STATE_CONNECTING;

    // libdatachannel 会自动生成 SDP 并调用 on_local_description 回调
    // 不需要手动调用 rtcGetLocalDescription

    printf("[WebRTC] PeerConnection 和 DataChannel 已创建，等待 SDP 生成...\n");

    // 返回 device_id 副本，表示创建成功
    return strdup(conn->device_id);
#else
    return NULL;
#endif
}

bool webrtc_set_answer(const char* device_id, const char* sdp) {
#ifdef USE_WEBRTC
    DeviceConnection* conn = find_connection(device_id);
    if (!conn || conn->pc < 0 || !sdp) {
        return false;
    }

    // 设置远程描述
    int result = rtcSetRemoteDescription(conn->pc, sdp, "answer");
    if (result < 0) {
        printf("[WebRTC] 设置远程描述失败\n");
        return false;
    }

    printf("[WebRTC] 已设置远程 Answer\n");
    return true;
#else
    return false;
#endif
}

bool webrtc_add_ice_candidate(const char* device_id, const char* candidate) {
#ifdef USE_WEBRTC
    DeviceConnection* conn = find_connection(device_id);
    if (!conn || conn->pc < 0 || !candidate) {
        return false;
    }

    // 添加 ICE candidate
    // 注意：libdatachannel 的 API 可能需要解析 candidate 字符串
    // 这里假设 candidate 格式为 "candidate:..."
    int result = rtcAddRemoteCandidate(conn->pc, candidate, NULL);
    return result >= 0;
#else
    return false;
#endif
}

bool webrtc_send_video(const char* device_id, const uint8_t* data, size_t len) {
#ifdef USE_WEBRTC
    DeviceConnection* conn = find_connection(device_id);
    if (!conn || conn->dc < 0 || conn->state != WEBRTC_STATE_CONNECTED || !data || len == 0) {
        return false;
    }

    uint32_t frame_seq = conn->next_frame_seq++;
    if (conn->next_frame_seq == 0) {
        conn->next_frame_seq = 1;
    }

    // 帧入队前检查 DataChannel 发送水位：超过预算说明网络排空不及时，
    // 继续发送只会累积旧画面。返回 false 让转发线程停止提交依赖帧并等待新 IDR
    if (conn->send_budget_bytes > 0) {
        int buffered = rtcGetBufferedAmount(conn->dc);
        if (buffered >= 0 && (size_t)buffered > conn->send_budget_bytes) {
            conn->frames_dropped++;
            return false;
        }
    }

    uint8_t packet[VIDEO_CHUNK_HEADER_SIZE + VIDEO_CHUNK_PAYLOAD_MAX];
    size_t offset = 0;
    while (offset < len) {
        size_t chunk_len = len - offset;
        if (chunk_len > VIDEO_CHUNK_PAYLOAD_MAX) {
            chunk_len = VIDEO_CHUNK_PAYLOAD_MAX;
        }

        uint8_t flags = 0;
        if (offset == 0) {
            flags |= 0x01; // start
        }
        if (offset + chunk_len == len) {
            flags |= 0x02; // end
        }

        packet[0] = VIDEO_CHUNK_MAGIC;
        packet[1] = flags;
        packet[2] = (uint8_t)(frame_seq & 0xFF);
        packet[3] = (uint8_t)((frame_seq >> 8) & 0xFF);
        packet[4] = (uint8_t)((frame_seq >> 16) & 0xFF);
        packet[5] = (uint8_t)((frame_seq >> 24) & 0xFF);
        memcpy(packet + VIDEO_CHUNK_HEADER_SIZE, data + offset, chunk_len);

        int result = rtcSendMessage(conn->dc, (const char*)packet,
                                    (int)(VIDEO_CHUNK_HEADER_SIZE + chunk_len));
        if (result < 0) {
            printf("[WebRTC] 发送视频分片失败: device=%s frame=%u offset=%zu chunk=%zu total=%zu\n",
                   device_id, frame_seq, offset, chunk_len, len);
            conn->frames_dropped++;
            return false;
        }

        offset += chunk_len;
    }

    conn->frames_sent++;
    return true;
#else
    return false;
#endif
}

void webrtc_set_send_budget(size_t bytes) {
    g_send_budget_bytes = bytes;
#ifdef USE_WEBRTC
    for (int i = 0; i < g_connection_count; i++) {
        g_connections[i].send_budget_bytes = bytes;
    }
#endif
}

int webrtc_get_buffered_amount(const char* device_id) {
#ifdef USE_WEBRTC
    DeviceConnection* conn = find_connection(device_id);
    if (!conn || conn->dc < 0) {
        return -1;
    }
    return rtcGetBufferedAmount(conn->dc);
#else
    return -1;
#endif
}

uint64_t webrtc_get_frames_sent(const char* device_id) {
    DeviceConnection* conn = find_connection(device_id);
    return conn ? conn->frames_sent : 0;
}

uint64_t webrtc_get_frames_dropped(const char* device_id) {
    DeviceConnection* conn = find_connection(device_id);
    return conn ? conn->frames_dropped : 0;
}

// 通过 DataChannel 发送文本消息（用于指标上报；size=-1 表示文本）
bool webrtc_send_text(const char* device_id, const char* text) {
#ifdef USE_WEBRTC
    DeviceConnection* conn = find_connection(device_id);
    if (!conn || conn->dc < 0 || conn->state != WEBRTC_STATE_CONNECTED || !text) {
        return false;
    }
    return rtcSendMessage(conn->dc, text, -1) >= 0;
#else
    return false;
#endif
}

void webrtc_close(const char* device_id) {
#ifdef USE_WEBRTC
    DeviceConnection* conn = find_connection(device_id);
    if (!conn) {
        return;
    }

    if (conn->dc >= 0) {
        rtcDeleteDataChannel(conn->dc);
        conn->dc = -1;
    }

    if (conn->pc >= 0) {
        rtcClosePeerConnection(conn->pc);
        conn->pc = -1;
    }

    conn->state = WEBRTC_STATE_DISCONNECTED;
    printf("[WebRTC] 已关闭连接: %s\n", device_id);
#endif
}

WebRTCState webrtc_get_state(const char* device_id) {
    DeviceConnection* conn = find_connection(device_id);
    return conn ? conn->state : WEBRTC_STATE_DISCONNECTED;
}

void webrtc_set_state_callback(WebRTCStateCallback callback) {
    g_state_callback = callback;
}

void webrtc_set_message_callback(WebRTCMessageCallback callback) {
    g_message_callback = callback;
}

void webrtc_set_data_message_callback(WebRTCDataMessageCallback callback) {
    g_data_message_callback = callback;
}

bool webrtc_is_available(void) {
#ifdef USE_WEBRTC
    return true;
#else
    return false;
#endif
}
