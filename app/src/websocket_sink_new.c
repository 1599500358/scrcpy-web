#include "websocket_sink.h"

#include <assert.h>
#include <string.h>

#include "util/log.h"

#define DOWNCAST(SINK) container_of(SINK, struct sc_websocket_sink, packet_sink)

// WebSocket 帧格式
static void
websocket_send_binary(sc_socket socket, const uint8_t *data, size_t len) {
    uint8_t header[10];
    size_t header_len;
    
    header[0] = 0x82; // FIN + Binary frame
    
    if (len < 126) {
        header[1] = (uint8_t)len;
        header_len = 2;
    } else if (len < 65536) {
        header[1] = 126;
        header[2] = (len >> 8) & 0xFF;
        header[3] = len & 0xFF;
        header_len = 4;
    } else {
        header[1] = 127;
        for (int i = 0; i < 8; i++) {
            header[9 - i] = (len >> (i * 8)) & 0xFF;
        }
        header_len = 10;
    }
    
    // 发送头部
    send(socket, (char*)header, header_len, 0);
    // 发送数据
    send(socket, (char*)data, len, 0);
}

static bool
connect_to_relay_server(struct sc_websocket_sink *ws) {
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
    
    LOGI("Connecting to relay server %s:%s", host, port);
    
    // 创建 socket
    ws->client_socket = socket(AF_INET, SOCK_STREAM, 0);
    if (ws->client_socket == SC_SOCKET_NONE) {
        LOGE("Could not create WebSocket client socket");
        return false;
    }
    
    // 解析地址
    struct sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(atoi(port));
    
    if (strcmp(host, "localhost") == 0) {
        server_addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    } else {
        server_addr.sin_addr.s_addr = inet_addr(host);
    }
    
    // 连接
    if (connect(ws->client_socket, (struct sockaddr*)&server_addr, sizeof(server_addr)) < 0) {
        LOGE("Could not connect to relay server %s:%s", host, port);
        net_close(ws->client_socket);
        ws->client_socket = SC_SOCKET_NONE;
        return false;
    }
    
    // 发送 WebSocket 握手
    char handshake[1024];
    snprintf(handshake, sizeof(handshake),
        "GET /?type=scrcpy&serial=%s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n",
        ws->device_serial, host);
    
    if (send(ws->client_socket, handshake, strlen(handshake), 0) <= 0) {
        LOGE("Failed to send WebSocket handshake");
        net_close(ws->client_socket);
        ws->client_socket = SC_SOCKET_NONE;
        return false;
    }
    
    // 接收响应
    char response[1024];
    ssize_t received = recv(ws->client_socket, response, sizeof(response) - 1, 0);
    if (received <= 0) {
        LOGE("Failed to receive WebSocket handshake response");
        net_close(ws->client_socket);
        ws->client_socket = SC_SOCKET_NONE;
        return false;
    }
    
    response[received] = '\0';
    
    if (!strstr(response, "101 Switching Protocols")) {
        LOGE("WebSocket handshake failed: %s", response);
        net_close(ws->client_socket);
        ws->client_socket = SC_SOCKET_NONE;
        return false;
    }
    
    LOGI("Connected to relay server successfully");
    return true;
}

static int
run_websocket_thread(void *data) {
    struct sc_websocket_sink *ws = data;
    
    // 连接到中继服务器
    if (!connect_to_relay_server(ws)) {
        LOGE("Failed to connect to relay server");
        sc_mutex_lock(&ws->mutex);
        ws->stopped = true;
        sc_mutex_unlock(&ws->mutex);
        return 1;
    }
    
    sc_mutex_lock(&ws->mutex);
    ws->connected = true;
    sc_mutex_unlock(&ws->mutex);
    
    LOGI("WebSocket connection ready for device: %s", ws->device_serial);
    
    // 保持连接
    while (!ws->stopped) {
#ifdef _WIN32
        Sleep(1000);
#else
        sleep(1);
#endif
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
    ws->connected = false;
    ws->client_socket = SC_SOCKET_NONE;
    
    LOGI("Starting WebSocket connection thread...");
    
    ok = sc_thread_create(&ws->thread, run_websocket_thread,
                         "scrcpy-ws", ws);
    if (!ok) {
        LOGE("Could not start WebSocket thread");
        sc_mutex_destroy(&ws->mutex);
        return false;
    }
    
    // 等待连接建立
    for (int i = 0; i < 50; i++) { // 最多等待 5 秒
        sc_mutex_lock(&ws->mutex);
        bool connected = ws->connected;
        sc_mutex_unlock(&ws->mutex);
        
        if (connected) {
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
    
    if (ws->client_socket != SC_SOCKET_NONE) {
        net_close(ws->client_socket);
    }
    
    sc_thread_join(&ws->thread, NULL);
    sc_mutex_destroy(&ws->mutex);
    
    LOGI("WebSocket sink closed");
}

static bool
sc_websocket_sink_push(struct sc_websocket_sink *ws, const AVPacket *packet) {
    sc_mutex_lock(&ws->mutex);
    bool connected = ws->connected;
    sc_socket socket = ws->client_socket;
    sc_mutex_unlock(&ws->mutex);
    
    if (!connected || socket == SC_SOCKET_NONE) {
        LOGW("WebSocket not connected, dropping packet");
        return false;
    }
    
    // 直接通过 WebSocket 发送 H.264 packet 数据
    websocket_send_binary(socket, packet->data, packet->size);
    
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
sc_websocket_sink_destroy(struct sc_websocket_sink *ws) {
    (void) ws;
    LOGI("WebSocket sink destroyed");
}
