/**
 * WebRTC 支持模块 (使用 libdatachannel)
 * 用于 P2P 视频传输
 *
 * 编译需要：
 * 1. 下载 libdatachannel 预编译包：https://github.com/paullouisageneau/libdatachannel/releases
 * 2. 将 include/rtc.h 放到同目录或 include 路径
 * 3. 将 datachannel.dll 放到同目录
 * 4. 链接 datachannel.lib
 */

#ifndef WEBRTC_SUPPORT_H
#define WEBRTC_SUPPORT_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// WebRTC 配置结构
typedef struct {
    char stun_server[256];      // STUN 服务器地址
    char turn_server[256];      // TURN 服务器地址（可选）
    char turn_username[128];    // TURN 用户名（可选）
    char turn_password[128];    // TURN 密码（可选）
} WebRTCConfig;

// WebRTC 连接状态
typedef enum {
    WEBRTC_STATE_DISCONNECTED = 0,
    WEBRTC_STATE_CONNECTING = 1,
    WEBRTC_STATE_CONNECTED = 2,
    WEBRTC_STATE_FAILED = 3
} WebRTCState;

// 回调函数类型
typedef void (*WebRTCStateCallback)(const char* device_id, WebRTCState state);
typedef void (*WebRTCMessageCallback)(const char* device_id, const char* message);

// 初始化 WebRTC
bool webrtc_init(const WebRTCConfig* config);

// 清理 WebRTC 资源
void webrtc_cleanup(void);

// 创建 PeerConnection 并生成 Offer
// 返回 SDP offer 字符串（需要调用者释放）
char* webrtc_create_offer(const char* device_id);

// 设置远程 Answer
bool webrtc_set_answer(const char* device_id, const char* sdp);

// 添加 ICE Candidate
bool webrtc_add_ice_candidate(const char* device_id, const char* candidate);

// 发送视频数据
bool webrtc_send_video(const char* device_id, const uint8_t* data, size_t len);

// 关闭 WebRTC 连接
void webrtc_close(const char* device_id);

// 获取 WebRTC 连接状态
WebRTCState webrtc_get_state(const char* device_id);

// 设置状态回调
void webrtc_set_state_callback(WebRTCStateCallback callback);

// 设置消息回调（用于发送信令消息）
void webrtc_set_message_callback(WebRTCMessageCallback callback);

// 检查 WebRTC 是否可用
bool webrtc_is_available(void);

#ifdef __cplusplus
}
#endif

#endif // WEBRTC_SUPPORT_H