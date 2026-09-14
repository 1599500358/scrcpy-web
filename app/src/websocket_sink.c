#include "websocket_sink.h"

#include <assert.h>
#include <inttypes.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>

#include "util/log.h"
#include "control_msg.h"
#include "android/input.h"
#include "android/keycodes.h"

#define DOWNCAST(SINK) container_of(SINK, struct sc_websocket_sink, packet_sink)

//处理WebSocket接收到的控制消息
static void
handle_control_message(struct sc_websocket_sink *ws, const char *message) {
    // 移除详细日志：LOGI("Received control message: %s", message);
    
    // 简单的JSON解析（查找 "action":"xxx"）
    char *action_start = strstr(message, "\"action\":\"");
    if (!action_start) {
        LOGW("No action field in message");
        return;
    }
    
    if (!ws->controller) {
        LOGW("Controller not set, cannot send control message");
        return;
    }
    
    action_start += 10; // 跳过 "action":"
    char *action_end = strchr(action_start, '"');
    if (!action_end) {
        return;
    }
    
    char action[64];
    int len = action_end - action_start;
    if (len >= (int)sizeof(action)) {
        return;
    }
    strncpy(action, action_start, len);
    action[len] = '\0';
    
    // 高频触摸下逐条打印会产生明显开销，降为 DEBUG
    LOGD("Received control action: %s", action);
    
    struct sc_control_msg msg;
    memset(&msg, 0, sizeof(msg));
    
    // 按键控制
    if (strcmp(action, "home") == 0) {
        msg.type = SC_CONTROL_MSG_TYPE_INJECT_KEYCODE;
        msg.inject_keycode.action = AKEY_EVENT_ACTION_DOWN;
        msg.inject_keycode.keycode = AKEYCODE_HOME;
        msg.inject_keycode.repeat = 0;
        msg.inject_keycode.metastate = 0;
        sc_controller_push_msg(ws->controller, &msg);
        
        msg.inject_keycode.action = AKEY_EVENT_ACTION_UP;
        sc_controller_push_msg(ws->controller, &msg);
    }
    else if (strcmp(action, "back") == 0) {
        msg.type = SC_CONTROL_MSG_TYPE_INJECT_KEYCODE;
        msg.inject_keycode.action = AKEY_EVENT_ACTION_DOWN;
        msg.inject_keycode.keycode = AKEYCODE_BACK;
        msg.inject_keycode.repeat = 0;
        msg.inject_keycode.metastate = 0;
        sc_controller_push_msg(ws->controller, &msg);
        
        msg.inject_keycode.action = AKEY_EVENT_ACTION_UP;
        sc_controller_push_msg(ws->controller, &msg);
    }
    else if (strcmp(action, "recent") == 0) {
        msg.type = SC_CONTROL_MSG_TYPE_INJECT_KEYCODE;
        msg.inject_keycode.action = AKEY_EVENT_ACTION_DOWN;
        msg.inject_keycode.keycode = AKEYCODE_APP_SWITCH;
        msg.inject_keycode.repeat = 0;
        msg.inject_keycode.metastate = 0;
        sc_controller_push_msg(ws->controller, &msg);
        
        msg.inject_keycode.action = AKEY_EVENT_ACTION_UP;
        sc_controller_push_msg(ws->controller, &msg);
    }
    else if (strcmp(action, "power") == 0) {
        msg.type = SC_CONTROL_MSG_TYPE_INJECT_KEYCODE;
        msg.inject_keycode.action = AKEY_EVENT_ACTION_DOWN;
        msg.inject_keycode.keycode = AKEYCODE_POWER;
        msg.inject_keycode.repeat = 0;
        msg.inject_keycode.metastate = 0;
        sc_controller_push_msg(ws->controller, &msg);
        
        msg.inject_keycode.action = AKEY_EVENT_ACTION_UP;
        sc_controller_push_msg(ws->controller, &msg);
    }
    else if (strcmp(action, "volumeUp") == 0) {
        msg.type = SC_CONTROL_MSG_TYPE_INJECT_KEYCODE;
        msg.inject_keycode.action = AKEY_EVENT_ACTION_DOWN;
        msg.inject_keycode.keycode = AKEYCODE_VOLUME_UP;
        msg.inject_keycode.repeat = 0;
        msg.inject_keycode.metastate = 0;
        sc_controller_push_msg(ws->controller, &msg);
        
        msg.inject_keycode.action = AKEY_EVENT_ACTION_UP;
        sc_controller_push_msg(ws->controller, &msg);
    }
    else if (strcmp(action, "volumeDown") == 0) {
        msg.type = SC_CONTROL_MSG_TYPE_INJECT_KEYCODE;
        msg.inject_keycode.action = AKEY_EVENT_ACTION_DOWN;
        msg.inject_keycode.keycode = AKEYCODE_VOLUME_DOWN;
        msg.inject_keycode.repeat = 0;
        msg.inject_keycode.metastate = 0;
        sc_controller_push_msg(ws->controller, &msg);
        
        msg.inject_keycode.action = AKEY_EVENT_ACTION_UP;
        sc_controller_push_msg(ws->controller, &msg);
    }
    else if (strcmp(action, "resetVideo") == 0 || strcmp(action, "requestKeyFrame") == 0) {
        msg.type = SC_CONTROL_MSG_TYPE_RESET_VIDEO;
        if (!sc_controller_push_msg(ws->controller, &msg)) {
            LOGW("Could not request reset video");
        } else {
            LOGI("Requested encoder reset for keyframe");
        }
    }
    else if (strcmp(action, "requestSyncFrame") == 0) {
        // 轻量同步帧请求：不重置捕获/编码链路（需要配套的 scrcpy-server 支持）
        msg.type = SC_CONTROL_MSG_TYPE_REQUEST_SYNC_FRAME;
        if (!sc_controller_push_msg(ws->controller, &msg)) {
            LOGW("Could not request sync frame");
        } else {
            LOGI("Requested sync frame");
        }
    }
    else if (strcmp(action, "touch") == 0) {
        // 触摸事件
        char *x_start = strstr(message, "\"x\":");
        char *y_start = strstr(message, "\"y\":");
        char *width_start = strstr(message, "\"width\":");
        char *height_start = strstr(message, "\"height\":");
        char *touchType_start = strstr(message, "\"touchType\":\"");
        
        if (x_start && y_start && width_start && height_start && touchType_start) {
            // 解析绝对坐标和分辨率
            int x_abs, y_abs, video_width, video_height;
            sscanf(x_start + 4, "%d", &x_abs);
            sscanf(y_start + 4, "%d", &y_abs);
            sscanf(width_start + 8, "%d", &video_width);
            sscanf(height_start + 9, "%d", &video_height);
            
            // 解析触摸类型
            touchType_start += 13;
            char *touchType_end = strchr(touchType_start, '"');
            if (!touchType_end) {
                return;
            }
            
            char touchType[16];
            int touch_len = touchType_end - touchType_start;
            if (touch_len >= (int)sizeof(touchType)) {
                return;
            }
            strncpy(touchType, touchType_start, touch_len);
            touchType[touch_len] = '\0';
            
            // 移除详细日志，减少性能影响
            // LOGI("Touch: type=%s, pos=(%d,%d), screen=%dx%d", 
            //      touchType, x_abs, y_abs, video_width, video_height);
            
            // 构造触摸事件（按“手指触控”语义注入，而不是鼠标语义）
            msg.type = SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT;
            msg.inject_touch_event.pointer_id = SC_POINTER_ID_GENERIC_FINGER;
            msg.inject_touch_event.position.point.x = x_abs;
            msg.inject_touch_event.position.point.y = y_abs;
            msg.inject_touch_event.position.screen_size.width = video_width;
            msg.inject_touch_event.position.screen_size.height = video_height;
            msg.inject_touch_event.action_button = 0;
            msg.inject_touch_event.buttons = 0;
            
            if (strcmp(touchType, "down") == 0) {
                msg.inject_touch_event.action = AMOTION_EVENT_ACTION_DOWN;
                msg.inject_touch_event.pressure = 1.0f;
            } else if (strcmp(touchType, "move") == 0) {
                msg.inject_touch_event.action = AMOTION_EVENT_ACTION_MOVE;
                msg.inject_touch_event.pressure = 1.0f;
            } else if (strcmp(touchType, "up") == 0) {
                msg.inject_touch_event.action = AMOTION_EVENT_ACTION_UP;
                msg.inject_touch_event.pressure = 0.0f;
            } else {
                return;
            }

            bool pushed = sc_controller_push_msg(ws->controller, &msg);
            if (!pushed) {
                LOGW("Touch control push failed: type=%s", touchType);
            } else if (strcmp(touchType, "move") != 0) {
                LOGI("Touch control pushed: type=%s x=%d y=%d", touchType, x_abs, y_abs);
            }
        }
    }
}

// WebSocket 帧格式（客户端发送需要 MASK）
static void
websocket_send_binary(sc_socket socket, const uint8_t *data, size_t len) {
    uint8_t header[14];
    size_t header_len;
    
    header[0] = 0x82; // FIN + Binary frame
    
    // 生成随机 masking key
    uint8_t masking_key[4];
    for (int i = 0; i < 4; i++) {
        masking_key[i] = rand() & 0xFF;
    }
    
    // 将 masking_key 转换为 32 位整数，用于快速 masking
    uint32_t mask32;
    memcpy(&mask32, masking_key, 4);
    
    if (len < 126) {
        header[1] = 0x80 | (uint8_t)len; // MASK 位设置为 1
        memcpy(&header[2], masking_key, 4);
        header_len = 6;
    } else if (len < 65536) {
        header[1] = 0x80 | 126; // MASK 位设置为 1
        header[2] = (len >> 8) & 0xFF;
        header[3] = len & 0xFF;
        memcpy(&header[4], masking_key, 4);
        header_len = 8;
    } else {
        header[1] = 0x80 | 127; // MASK 位设置为 1
        for (int i = 0; i < 8; i++) {
            header[2 + i] = (len >> ((7 - i) * 8)) & 0xFF;
        }
        memcpy(&header[10], masking_key, 4);
        header_len = 14;
    }
    
    // 发送头部
    if (net_send_all(socket, header, header_len) != (ssize_t) header_len) {
        return;
    }
    
    // 优化的 masking：使用 4 字节对齐处理
    if (len < 8192) {
        uint8_t masked_data[8192];
        size_t i = 0;
        
        // 4 字节对齐处理（快速）
        size_t len_aligned = len & ~3; // 向下对齐到 4 的倍数
        for (; i < len_aligned; i += 4) {
            *((uint32_t*)(masked_data + i)) = *((uint32_t*)(data + i)) ^ mask32;
        }
        
        // 处理剩余字节
        for (; i < len; i++) {
            masked_data[i] = data[i] ^ masking_key[i % 4];
        }
        
        net_send_all(socket, masked_data, len);
    } else {
        uint8_t *masked_data = malloc(len);
        if (masked_data) {
            size_t i = 0;
            
            // 4 字节对齐处理（快速）
            size_t len_aligned = len & ~3;
            for (; i < len_aligned; i += 4) {
                *((uint32_t*)(masked_data + i)) = *((uint32_t*)(data + i)) ^ mask32;
            }
            
            // 处理剩余字节
            for (; i < len; i++) {
                masked_data[i] = data[i] ^ masking_key[i % 4];
            }
            
            net_send_all(socket, masked_data, len);
            free(masked_data);
        }
    }
}

// 读取一个完整的 WebSocket 帧（用于控制消息）
// 返回 payload 长度，失败返回 -1
static ssize_t
websocket_recv_frame(sc_socket socket, uint8_t *payload, size_t payload_cap, uint8_t *opcode_out) {
    uint8_t header[2];
    ssize_t r = net_recv_all(socket, header, sizeof(header));
    if (r != (ssize_t) sizeof(header)) {
        return -1;
    }

    uint8_t opcode = header[0] & 0x0F;
    bool masked = (header[1] & 0x80) != 0;
    uint64_t payload_len = header[1] & 0x7F;

    if (payload_len == 126) {
        uint8_t ext[2];
        if (net_recv_all(socket, ext, sizeof(ext)) != (ssize_t) sizeof(ext)) {
            return -1;
        }
        payload_len = ((uint64_t) ext[0] << 8) | ext[1];
    } else if (payload_len == 127) {
        uint8_t ext[8];
        if (net_recv_all(socket, ext, sizeof(ext)) != (ssize_t) sizeof(ext)) {
            return -1;
        }
        payload_len = 0;
        for (int i = 0; i < 8; ++i) {
            payload_len = (payload_len << 8) | ext[i];
        }
    }

    uint8_t mask[4] = {0};
    if (masked) {
        if (net_recv_all(socket, mask, sizeof(mask)) != (ssize_t) sizeof(mask)) {
            return -1;
        }
    }

    if (payload_len >= payload_cap) {
        LOGW("Control frame too large: %llu (cap=%u)",
             (unsigned long long) payload_len, (unsigned) payload_cap);
        // 丢弃超长负载，保持流同步
        uint8_t dump[256];
        uint64_t remaining = payload_len;
        while (remaining > 0) {
            size_t chunk = remaining > sizeof(dump) ? sizeof(dump) : (size_t) remaining;
            if (net_recv_all(socket, dump, chunk) != (ssize_t) chunk) {
                return -1;
            }
            remaining -= chunk;
        }
        return -1;
    }

    if (payload_len > 0) {
        if (net_recv_all(socket, payload, (size_t) payload_len) != (ssize_t) payload_len) {
            return -1;
        }
        if (masked) {
            for (uint64_t i = 0; i < payload_len; ++i) {
                payload[i] ^= mask[i % 4];
            }
        }
    }

    payload[payload_len] = '\0';
    if (opcode_out) {
        *opcode_out = opcode;
    }
    return (ssize_t) payload_len;
}

// 连接到中继服务器（通用函数）
static sc_socket
connect_to_server(const char *host, const char *port, const char *path, const char *serial) {
    (void) serial;
    LOGI("Connecting to relay server %s:%s%s", host, port, path);
    
    // 创建 socket
    sc_socket sock = net_socket();
    if (sock == SC_SOCKET_NONE) {
        LOGE("Could not create WebSocket client socket");
        return SC_SOCKET_NONE;
    }
    
    uint32_t ipv4;
    const char *ip = strcmp(host, "localhost") == 0 ? "127.0.0.1" : host;
    if (!net_parse_ipv4(ip, &ipv4)) {
        LOGE("Invalid relay host: %s", host);
        net_close(sock);
        return SC_SOCKET_NONE;
    }

    int port_int = atoi(port);
    if (port_int <= 0 || port_int > 65535) {
        LOGE("Invalid relay port: %s", port);
        net_close(sock);
        return SC_SOCKET_NONE;
    }

    // 连接
    if (!net_connect(sock, ipv4, (uint16_t) port_int)) {
        LOGE("Could not connect to relay server %s:%s", host, port);
        net_close(sock);
        return SC_SOCKET_NONE;
    }
    
    // 设置 TCP_NODELAY 减少延迟
    (void) net_set_tcp_nodelay(sock, true);
    
    // 发送 WebSocket 握手
    char handshake[1024];
    snprintf(handshake, sizeof(handshake),
        "GET %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n",
        path, host);
    
    size_t handshake_len = strlen(handshake);
    if (net_send_all(sock, handshake, handshake_len) != (ssize_t) handshake_len) {
        LOGE("Failed to send WebSocket handshake");
        net_close(sock);
        return SC_SOCKET_NONE;
    }
    
    // 接收响应
    char response[1024];
    ssize_t received = net_recv(sock, response, sizeof(response) - 1);
    if (received <= 0) {
        LOGE("Failed to receive WebSocket handshake response");
        net_close(sock);
        return SC_SOCKET_NONE;
    }
    
    response[received] = '\0';
    
    if (!strstr(response, "101 Switching Protocols")) {
        LOGE("WebSocket handshake failed: %s", response);
        net_close(sock);
        return SC_SOCKET_NONE;
    }
    
    LOGI("Connected to %s successfully", path);
    return sock;
}

static int
run_websocket_thread(void *data) {
    struct sc_websocket_sink *ws = data;
    
    // 初始化随机数生成器（用于 WebSocket masking key）
    srand((unsigned int)time(NULL));
    
    // 解析服务器地址
    char host[256];
    char port[16] = "8080";
    
    char *colon = strchr(ws->server_url, ':');
    if (colon) {
        size_t host_len = colon - ws->server_url;
        if (host_len >= sizeof(host)) {
            host_len = sizeof(host) - 1;
        }
        memcpy(host, ws->server_url, host_len);
        host[host_len] = '\0';
        strncpy(port, colon + 1, sizeof(port) - 1);
    } else {
        strncpy(host, ws->server_url, sizeof(host) - 1);
    }
    
    // 连接 1：视频发送连接
    char video_path[512];
    snprintf(video_path, sizeof(video_path), "/?type=scrcpy&serial=%s", ws->device_serial);
    ws->video_socket = connect_to_server(host, port, video_path, ws->device_serial);
    
    if (ws->video_socket == SC_SOCKET_NONE) {
        LOGE("Failed to connect video socket");
        sc_mutex_lock(&ws->mutex);
        ws->stopped = true;
        sc_mutex_unlock(&ws->mutex);
        return 1;
    }
    
    sc_mutex_lock(&ws->mutex);
    ws->video_connected = true;
    sc_mutex_unlock(&ws->mutex);
    LOGI("Video socket connected");
    
    // 连接 2：控制接收连接
    char control_path[512];
    snprintf(control_path, sizeof(control_path), "/?type=control&serial=%s", ws->device_serial);
    ws->control_socket = connect_to_server(host, port, control_path, ws->device_serial);
    
    if (ws->control_socket == SC_SOCKET_NONE) {
        LOGE("Failed to connect control socket");
        sc_mutex_lock(&ws->mutex);
        ws->control_connected = false;
        sc_mutex_unlock(&ws->mutex);
        // 控制连接失败不影响视频，继续运行
    } else {
        sc_mutex_lock(&ws->mutex);
        ws->control_connected = true;
        sc_mutex_unlock(&ws->mutex);
        LOGI("Control socket connected");
    }
    
    LOGI("WebSocket dual connections ready for device: %s", ws->device_serial);
    
    // 接收控制消息（只从 control_socket 接收）
    uint8_t buffer[4096];
    while (!ws->stopped) {
        // 如果控制连接不可用，等待后重试
        if (ws->control_socket == SC_SOCKET_NONE) {
#ifdef _WIN32
            Sleep(1000);
#else
            usleep(1000000);
#endif
            continue;
        }

        uint8_t opcode = 0;
        ssize_t payload_len =
            websocket_recv_frame(ws->control_socket, buffer, sizeof(buffer), &opcode);
        if (payload_len < 0) {
            if (ws->stopped) {
                break;
            }

            LOGW("Control socket closed, reconnecting...");
            net_close(ws->control_socket);
            ws->control_socket = SC_SOCKET_NONE;
            sc_mutex_lock(&ws->mutex);
            ws->control_connected = false;
            sc_mutex_unlock(&ws->mutex);
            continue;
        }

        if (opcode == 0x01 && payload_len > 0) { // Text frame
            handle_control_message(ws, (const char *) buffer);
        } else if (opcode == 0x08) { // Close
            LOGW("Control socket sent close frame");
            net_close(ws->control_socket);
            ws->control_socket = SC_SOCKET_NONE;
            sc_mutex_lock(&ws->mutex);
            ws->control_connected = false;
            sc_mutex_unlock(&ws->mutex);
        }
    }
    
    LOGD("WebSocket thread ended");
    return 0;
}

static bool
sc_websocket_sink_open(struct sc_websocket_sink *ws, AVCodecContext *ctx) {
    (void) ctx; // 不需要 codec context，直接转发 packet
    
    bool ok = sc_mutex_init(&ws->mutex);
    if (!ok) {
        return false;
    }
    
    ws->stopped = false;
    ws->video_connected = false;
    ws->control_connected = false;
    ws->video_socket = SC_SOCKET_NONE;
    ws->control_socket = SC_SOCKET_NONE;
    
    LOGI("Starting WebSocket dual connection thread...");
    
    ok = sc_thread_create(&ws->thread, run_websocket_thread,
                         "scrcpy-ws", ws);
    if (!ok) {
        LOGE("Could not start WebSocket thread");
        sc_mutex_destroy(&ws->mutex);
        return false;
    }
    
    // 等待视频连接建立（控制连接可选）
    for (int i = 0; i < 50; i++) { // 最多等待 5 秒
        sc_mutex_lock(&ws->mutex);
        bool video_connected = ws->video_connected;
        sc_mutex_unlock(&ws->mutex);
        
        if (video_connected) {
            break;
        }
        
#ifdef _WIN32
        Sleep(100);
#else
        usleep(100000);
#endif
    }
    
    LOGI("WebSocket sink opened successfully");
    return true;
}

static void
sc_websocket_sink_close(struct sc_websocket_sink *ws) {
    sc_mutex_lock(&ws->mutex);
    ws->stopped = true;
    sc_mutex_unlock(&ws->mutex);
    
    if (ws->video_socket != SC_SOCKET_NONE) {
        net_interrupt(ws->video_socket);
    }
    
    if (ws->control_socket != SC_SOCKET_NONE) {
        net_interrupt(ws->control_socket);
    }
    
    sc_thread_join(&ws->thread, NULL);

    if (ws->video_socket != SC_SOCKET_NONE) {
        net_close(ws->video_socket);
        ws->video_socket = SC_SOCKET_NONE;
    }

    if (ws->control_socket != SC_SOCKET_NONE) {
        net_close(ws->control_socket);
        ws->control_socket = SC_SOCKET_NONE;
    }

    sc_mutex_destroy(&ws->mutex);
    
    LOGI("WebSocket sink closed");
}

static bool
sc_websocket_sink_push(struct sc_websocket_sink *ws, const AVPacket *packet) {
    // 快速检查，不加锁（原子读取 bool 是安全的）
    if (!ws->video_connected) {
        return false;
    }
    
    // 直接发送到 video_socket，完全不受控制 socket 影响
    websocket_send_binary(ws->video_socket, packet->data, packet->size);
    
    return true;
}

static bool
sc_websocket_packet_sink_open(struct sc_packet_sink *sink, AVCodecContext *ctx) {
    struct sc_websocket_sink *ws = DOWNCAST(sink);
    return sc_websocket_sink_open(ws, ctx);
}

static void
sc_websocket_packet_sink_close(struct sc_packet_sink *sink) {
    struct sc_websocket_sink *ws = DOWNCAST(sink);
    sc_websocket_sink_close(ws);
}

static bool
sc_websocket_packet_sink_push(struct sc_packet_sink *sink, const AVPacket *packet) {
    struct sc_websocket_sink *ws = DOWNCAST(sink);
    return sc_websocket_sink_push(ws, packet);
}

static void
sc_websocket_packet_sink_disable(struct sc_packet_sink *sink) {
    struct sc_websocket_sink *ws = DOWNCAST(sink);
    (void) ws;
    LOGI("WebSocket sink disabled");
}

bool
sc_websocket_sink_init(struct sc_websocket_sink *ws, const char *server_url,
                       const char *device_serial) {
    strncpy(ws->server_url, server_url, sizeof(ws->server_url) - 1);
    ws->server_url[sizeof(ws->server_url) - 1] = '\0';
    
    strncpy(ws->device_serial, device_serial, sizeof(ws->device_serial) - 1);
    ws->device_serial[sizeof(ws->device_serial) - 1] = '\0';
    
    ws->controller = NULL; // 初始化 controller 为 NULL
    
    static const struct sc_packet_sink_ops ops = {
        .open = sc_websocket_packet_sink_open,
        .close = sc_websocket_packet_sink_close,
        .push = sc_websocket_packet_sink_push,
        .disable = sc_websocket_packet_sink_disable,
    };
    
    ws->packet_sink.ops = &ops;
    
    LOGI("WebSocket sink initialized for device %s, server: %s", 
         device_serial, server_url);
    
    return true;
}

void
sc_websocket_sink_set_controller(struct sc_websocket_sink *ws,
                                  struct sc_controller *controller) {
    ws->controller = controller;
    LOGI("WebSocket sink controller set");
}

void
sc_websocket_sink_destroy(struct sc_websocket_sink *ws) {
    (void) ws;
    LOGI("WebSocket sink destroyed");
}
