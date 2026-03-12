# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码仓库中工作时提供指导。

## 项目概述

**scrcpy-web** 是一个基于 [scrcpy](https://github.com/Genymobile/scrcpy) 构建的远程 Android 设备控制系统。它通过 WebSocket 中继服务器架构，实现了从 Web 浏览器查看和控制 Android 设备。

- **GitHub**: https://github.com/1599500358/scrcpy-web.git

## 系统架构

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Console Client │────▶│  Relay Server   │◀────│   Web Client    │
│  (Windows PC)   │     │    (Node.js)    │     │   (Browser)     │
│                 │     │                 │     │                 │
│  - scrcpy.exe   │     │  - WebSocket    │     │  - WebCodecs    │
│  - ADB devices  │     │  - Auth system  │     │  - H.264 decode │
│  - C client     │     │  - Device mgmt  │     │  - Touch events │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**数据流：**
1. 控制台客户端检测 ADB 设备并上报给中继服务器
2. Web 客户端从列表中选择设备
3. 中继服务器指示控制台为该设备启动 scrcpy
4. scrcpy 通过 WebSocket 发送 H.264 视频流到中继服务器
5. 中继服务器转发视频到 Web 客户端
6. Web 客户端使用 WebCodecs API 解码视频并捕获触摸事件
7. 触摸/控制事件通过中继服务器回传给 scrcpy

## 主要目录

- **relay-server/** - Node.js WebSocket 中继服务器（主要开发重点）
  - `server.js` - 主服务器，处理 WebSocket、认证、设备管理
  - `auth-manager.js` - 认证逻辑，包含 bcrypt 和锁定保护
  - `public/` - Web 前端（index.html, app.js）
- **scrcpy-console/** - Windows 控制台客户端（C 语言，预编译）
  - `scrcpy_console.c` - Windows 客户端源代码
  - `scrcpy-console.exe` - 编译后的可执行文件
- **app/** - 原始 scrcpy 源代码（带 WebSocket 修改）

## 部署环境

- **ser-server** - 已配置好的远程 SSH 服务器
  - 系统: Ubuntu
  - 用途: 线上部署 relay-server
  - 该服务器具有公网 IP，可作为 TURN 中继服务器

## 常用命令

### 中继服务器

```bash
cd relay-server
npm install           # 安装依赖
npm start             # 启动生产服务器
npm run dev           # 使用 nodemon 启动（自动重载）
```

### 控制台客户端 (Windows)

```batch
cd scrcpy-console
build.bat             # 使用 MSVC 编译
run.bat               # 使用默认服务器运行
scrcpy-console.exe 192.168.1.100:8080  # 使用自定义服务器运行
```

### 生产部署

```bash
# 使用 PM2
pm2 start ecosystem.config.js
pm2 logs              # 查看日志
pm2 restart scrcpy-relay-server
pm2 stop scrcpy-relay-server
```

## 环境变量

| 变量 | 默认值 | 说明 |
|----------|---------|-------------|
| `HTTP_PORT` | 8080 | HTTP 端口（用于 scrcpy 连接） |
| `HTTPS_PORT` | 8443 | HTTPS 端口（用于 Web 客户端） |
| `ENABLE_HTTPS` | false | 启用双 HTTP/HTTPS 模式 |
| `SSL_CERT_PATH` | cert/server.crt | SSL 证书路径 |
| `SSL_KEY_PATH` | cert/server.key | SSL 私钥路径 |
| `SESSION_SECRET` | (自动生成) | Session 签名密钥 |
| `LOG_LEVEL` | INFO | 日志级别 (ERROR/WARN/INFO/DEBUG) |
| `MAX_WS_BUFFERED_AMOUNT` | 8MB | WebSocket 缓冲区限制（用于背压控制） |
| `IDLE_TIMEOUT` | 300000 | 空闲设备自动断开时间（5 分钟） |

## WebSocket 消息类型

### 控制台 → 服务器
- `deviceList` - 上报可用设备
- `deviceUpdate` - 更新单个设备信息
- `prepareStream` - 预注册设备流

### 服务器 → 控制台
- `startDevice` / `stopDevice` - 控制流传输
- `deviceStreamingStarted` - 确认流开始

### Web → 服务器
- `selectDevice` - 选择要查看/控制的设备
- `touch` - 触摸事件 (down/move/up)
- `control` - 控制按钮 (home/back)
- `updateDeviceName` - 设置设备别名

### scrcpy → 服务器
- 二进制 H.264 Annex-B 视频帧

## 认证

系统使用基于 session 的认证，配合 bcrypt 密码哈希：
- 用户凭证存储在 `auth-config.json`
- 登录失败 5 次后触发锁定
- Session 在 1 小时后超时（可配置）
- WebSocket 连接验证 session cookie

## 视频流详情

- **格式**: H.264 Annex-B (NAL units)
- **编解码器**: WebCodecs API，使用 `avc1.*` 编解码器字符串
- **配置**: 从流中提取 SPS/PPS 来配置解码器
- **背压控制**: WebSocket `bufferedAmount` 检查防止内存溢出
- **关键帧**: 解码器等待 IDR 帧（NAL 类型 5）后才开始解码

## IP 地址匹配

系统支持无线 ADB 的灵活设备匹配：
- 精确匹配: `192.168.0.6:39743`
- IP 前缀匹配: `192.168.0.6` 可匹配 `192.168.0.6:39743`
- 适用于端口可能变化的无线调试场景

## 设备别名

设备自定义名称持久化存储在 `device_aliases.json`：
- 按设备序列号存储
- 服务端持久化，使用防抖写入
- 广播给 Web 客户端时与设备信息合并

## WebRTC P2P 支持

系统支持 WebRTC P2P 直连以降低延迟：

### 架构

```
scrcpy → 控制台 → WebRTC DataChannel → Web浏览器 → WebCodecs解码
                ↑
                ├─ P2P直连（NAT穿透成功时）
                └─ TURN中继（穿透失败时）
```

### 相关文件

- `relay-server/webrtc-signaling.js` - WebRTC 信令处理
- `relay-server/turn-server.js` - TURN 服务器模块
- `scrcpy-console/webrtc_support.c` - 控制台 WebRTC 支持

### 编译 WebRTC 版本

```bash
# macOS/Linux 交叉编译
cd scrcpy-console
./build-mingw.sh webrtc

# Windows 原生编译
build.bat webrtc
```

需要下载 libdatachannel 库：
- 地址: https://github.com/paullouisageneau/libdatachannel/releases
- 解压到 `scrcpy-console/libdatachannel/`

### 启用 TURN 服务器

```bash
TURN_ENABLED=true TURN_SECRET=your-secret npm start
```