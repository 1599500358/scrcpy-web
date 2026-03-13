/**
 * 本地 WebSocket 服务器 + WebRTC 视频转发模块
 */

#ifndef LOCAL_VIDEO_RELAY_H
#define LOCAL_VIDEO_RELAY_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// 视频连接建立回调类型
typedef void (*VideoConnectCallback)(const char* serial);

// 初始化本地视频转发服务器
bool init_local_video_relay(void);

// 停止本地服务器
void stop_local_video_relay(void);

// 获取本地服务器端口
int get_local_video_port(void);

// 检查本地服务器健康状态（监听 socket 是否有效）
bool is_local_video_relay_healthy(void);

// 关闭指定设备的本地连接
void close_local_client(const char* serial);

// 发送控制消息到 scrcpy
bool send_control_to_scrcpy(const char* serial, const uint8_t* data, size_t len);

// 设置视频连接建立回调
void set_video_connect_callback(VideoConnectCallback callback);

#ifdef __cplusplus
}
#endif

#endif // LOCAL_VIDEO_RELAY_H
