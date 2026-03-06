#ifndef SC_WEBSOCKET_SINK_H
#define SC_WEBSOCKET_SINK_H

#include "common.h"

#include <stdbool.h>
#include <libavcodec/avcodec.h>

#include "trait/packet_sink.h"
#include "util/thread.h"
#include "util/net.h"
#include "controller.h"  // 添加 controller 头文件

struct sc_websocket_sink {
    struct sc_packet_sink packet_sink; // packet sink trait

    char server_url[256];  // 中继服务器地址 (host:port)
    char device_serial[64]; // 设备序列号
    
    sc_socket video_socket;   // 视频发送专用 socket
    sc_socket control_socket; // 控制接收专用 socket
    
    sc_thread thread;
    sc_mutex mutex;
    
    bool stopped;
    bool video_connected;    // 视频连接状态
    bool control_connected;  // 控制连接状态
    
    struct sc_controller *controller; // 控制器引用，用于发送控制消息
};

bool
sc_websocket_sink_init(struct sc_websocket_sink *ws, const char *server_url, 
                       const char *device_serial);

void
sc_websocket_sink_set_controller(struct sc_websocket_sink *ws,
                                  struct sc_controller *controller);

void
sc_websocket_sink_destroy(struct sc_websocket_sink *ws);

#endif
