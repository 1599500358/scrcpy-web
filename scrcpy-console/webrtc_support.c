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

// 设备 WebRTC 连接信息
typedef struct {
    char device_id[256];
    int pc;  // PeerConnection ID (libdatachannel)
    int dc;  // DataChannel ID
    WebRTCState state;
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
    g_connection_count++;

    return conn;
}

#ifdef USE_WEBRTC

// DataChannel 打开回调
static void on_dc_open(int pc, void* ptr) {
    DeviceConnection* conn = (DeviceConnection*)ptr;
    if (conn) {
        conn->state = WEBRTC_STATE_CONNECTED;
        printf("[WebRTC] DataChannel 已打开: %s\n", conn->device_id);
        if (g_state_callback) {
            g_state_callback(conn->device_id, WEBRTC_STATE_CONNECTED);
        }
    }
}

// DataChannel 关闭回调
static void on_dc_closed(int pc, void* ptr) {
    DeviceConnection* conn = (DeviceConnection*)ptr;
    if (conn) {
        conn->state = WEBRTC_STATE_DISCONNECTED;
        printf("[WebRTC] DataChannel 已关闭: %s\n", conn->device_id);
        if (g_state_callback) {
            g_state_callback(conn->device_id, WEBRTC_STATE_DISCONNECTED);
        }
    }
}

// PeerConnection 本地描述回调（生成 Offer 后触发）
static void on_local_description(int pc, const char* sdp, const char* type, void* ptr) {
    DeviceConnection* conn = (DeviceConnection*)ptr;
    if (conn && sdp) {
        strncpy(conn->local_sdp, sdp, SDP_BUFFER_SIZE - 1);

        // 构造 JSON 格式的 Offer 消息
        char message[SDP_BUFFER_SIZE + 256];
        snprintf(message, sizeof(message),
            "{\"type\":\"webrtc-offer\",\"deviceId\":\"%s\",\"sdp\":{\"type\":\"offer\",\"sdp\":\"%s\"}}",
            conn->device_id, sdp);

        // 发送 Offer 到信令服务器
        if (g_message_callback) {
            g_message_callback(conn->device_id, message);
        }

        printf("[WebRTC] 已生成本地描述 (Offer)\n");
    }
}

// ICE Candidate 回调
static void on_ice_candidate(int pc, const char* candidate, const char* mid, void* ptr) {
    DeviceConnection* conn = (DeviceConnection*)ptr;
    if (conn && candidate) {
        // 缓存 ICE candidate
        if (conn->ice_count < MAX_ICE_CANDIDATES) {
            strncpy(conn->ice_candidates[conn->ice_count], candidate, 511);
            conn->ice_count++;
        }

        // 构造 ICE candidate 消息
        char message[1024];
        snprintf(message, sizeof(message),
            "{\"type\":\"webrtc-ice-candidate\",\"deviceId\":\"%s\",\"candidate\":{\"candidate\":\"%s\",\"sdpMid\":\"%s\"},\"from\":\"console\"}",
            conn->device_id, candidate, mid ? mid : "0");

        // 发送 ICE candidate 到信令服务器
        if (g_message_callback) {
            g_message_callback(conn->device_id, message);
        }
    }
}

// PeerConnection 状态改变回调
static void on_state_change(int pc, rtcState state, void* ptr) {
    DeviceConnection* conn = (DeviceConnection*)ptr;
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
    rtcInitLogger(RTC_LOG_LEVEL_WARNING, NULL);

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

    // 设置 STUN 服务器
    char ice_servers[512];
    if (g_config.turn_server[0] && g_config.turn_username[0]) {
        snprintf(ice_servers, sizeof(ice_servers),
            "stun:%s\n"  // STUN
            "turn:%s %s %s",  // TURN
            g_config.stun_server[0] ? g_config.stun_server : "stun.l.google.com:19302",
            g_config.turn_server,
            g_config.turn_username,
            g_config.turn_password);
    } else {
        snprintf(ice_servers, sizeof(ice_servers),
            "stun:%s",
            g_config.stun_server[0] ? g_config.stun_server : "stun.l.google.com:19302");
    }
    conf.iceServers = ice_servers;

    // 创建 PeerConnection
    conn->pc = rtcCreatePeerConnection(&conf);
    if (conn->pc < 0) {
        printf("[WebRTC] 创建 PeerConnection 失败\n");
        return NULL;
    }

    // 设置回调
    rtcSetLocalDescriptionCallback(conn->pc, on_local_description);
    rtcSetIceCandidateCallback(conn->pc, on_ice_candidate);
    rtcSetStateChangeCallback(conn->pc, on_state_change);

    // 创建 DataChannel
    rtcDataChannelInit dcInit;
    memset(&dcInit, 0, sizeof(dcInit));

    conn->dc = rtcCreateDataChannel(conn->pc, "video", &dcInit);
    if (conn->dc < 0) {
        printf("[WebRTC] 创建 DataChannel 失败\n");
        rtcClosePeerConnection(conn->pc);
        conn->pc = -1;
        return NULL;
    }

    // 设置 DataChannel 回调
    rtcSetOpenCallback(conn->dc, on_dc_open);
    rtcSetClosedCallback(conn->dc, on_dc_closed);

    conn->state = WEBRTC_STATE_CONNECTING;

    // 触发本地描述生成（这会调用 on_local_description 回调）
    // 注意：在 libdatachannel 中，设置 local description 会自动触发
    char sdp[SDP_BUFFER_SIZE];
    rtcGetLocalDescription(conn->pc, sdp, SDP_BUFFER_SIZE);

    // 返回 SDP（调用者需要释放）
    char* result = strdup(sdp);
    return result;
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
    if (!conn || conn->dc < 0 || conn->state != WEBRTC_STATE_CONNECTED) {
        return false;
    }

    // 发送二进制数据
    int result = rtcSendMessage(conn->dc, (const char*)data, (int)len);
    return result >= 0;
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
        rtcCloseDataChannel(conn->dc);
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

bool webrtc_is_available(void) {
#ifdef USE_WEBRTC
    return true;
#else
    return false;
#endif
}