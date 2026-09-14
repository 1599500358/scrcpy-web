# scrcpy-web 多客户端与管理后台通信架构与安全审计报告

> **审计对象**：`relay-server` (中继管理后台/服务端)、`scrcpy-console` (Windows 控制台客户端)、`web-client` (浏览器前端管理端)、`scrcpy` (视频/控制流端)  
> **审计范围**：通信协议、信令交互、鉴权与访问控制、多客户端并发与路由、输入校验与边界安全、抗拒绝服务 (DoS)

---

## 目录
- [一、 通信链路与交互全景 (Communication Topology)](#一-通信链路与交互全景)
- [二、 核心安全与架构问题矩阵 (Risk Matrix)](#二-核心安全与架构问题矩阵)
- [三、 详细审计发现 (Detailed Audit Findings)](#三-详细审计发现)
  - [1. 认证与权限控制漏洞 (Authentication & Authorization)](#1-认证与权限控制漏洞)
  - [2. 多客户端并发与多控制台路由冲突 (Concurrency & Multi-Console Routing)](#2-多客户端并发与多控制台路由冲突)
  - [3. 输入校验、命令执行与协议脆弱性 (Input Validation & Framing)](#3-输入校验命令执行与协议脆弱性)
  - [4. 拒绝服务与资源耗尽风险 (DoS & Resource Exhaustion)](#4-拒绝服务与资源耗尽风险)
  - [5. WebRTC 信令与多客户端适配缺陷 (WebRTC Signaling Issues)](#5-webrtc-信令与多客户端适配缺陷)
- [四、 针对性整改与优化方案 (Remediation Plan)](#四-针对性整改与优化方案)

---

## 一、 通信链路与交互全景

```
                        ┌────────────────────────────────────────────────────────┐
                        │              中继后台 / 管理服务端 (Relay Server)         │
                        │                 Node.js / Express / ws                 │
                        └───────▲────────────────────────▲───────────────▲───────┘
                                │                        │               │
            ① WebSocket         │      ② WebSocket       │               │ ③ WebSocket / HTTP
            (/?type=console)    │      (/?type=scrcpy    │               │ (/?type=web / APIs)
                                │       /?type=control)  │               │
               ┌────────────────┴──────┐                 │       ┌───────┴──────────────┐
               │  控制台客户端 (Console) │                 │       │ Web 管理端 (Browser)  │
               │  scrcpy-console.exe   │                 │       │ app.js / WebCodecs   │
               └──────────┬────────────┘                 │       └──────────────────────┘
                          │                              │
                          │ 本地拉起                      │
                          ▼                              │
               ┌─────────────────────┐                   │
               │   scrcpy.exe 实例    ├───────────────────┘
               │  (USB / Wi-Fi ADB)  │
               └─────────────────────┘
```

### 通信协议与信令汇总表

| 通信端 | 传输协议 | 握手路径 / 端点 | 鉴权机制 | 主要交换消息 / 数据 |
| :--- | :--- | :--- | :--- | :--- |
| **控制台客户端** (`scrcpy-console`) | WebSocket (文本) | `GET /?type=console` | **无**（完全未认证） | `welcome`, `deviceList`, `deviceUpdate`, `startDevice`, `stopDevice`, `prepareStream`, WebRTC 信令 |
| **Web 管理端** (`Browser`) | WebSocket (文本+二进制) | `GET /?type=web` | Session Cookie (`scrcpy.sid`) | `deviceList`, `deviceUpdate`, `selectDevice`, `touch`, `control`, H.264 视频流帧 |
| **原生推流端** (`scrcpy` Video) | WebSocket (纯二进制) | `GET /?type=scrcpy&serial=...` | 预注册校验 (单次) 或 Session | H.264 Annex-B 原始视频流帧 |
| **原生控制端** (`scrcpy` Control) | WebSocket (文本) | `GET /?type=control&serial=...` | **无**（完全未认证） | JSON 格式的触控事件、按键事件 |
| **Web REST API** | HTTP/HTTPS | `/api/login`, `/api/devices`, `/api/prepare-device-stream` 等 | Session / 无 | 设备别名、分组、WebRTC TURN 凭证等 |

---

## 二、 核心安全与架构问题矩阵

| 序号 | 问题描述 | 影响组件 | 风险等级 | 分类 |
| :--- | :--- | :--- | :---: | :--- |
| **SEC-01** | 控制台连接与控制通道（`type=control`）**完全未认证** | `server.js` | **严重 (Critical)** | 身份鉴权 |
| **SEC-02** | 跨站 WebSocket 劫持 (**CSWSH**)：未校验 Origin | `server.js`, `app.js` | **高危 (High)** | Web 安全 |
| **SEC-03** | 仓库提交默认 Session Secret 且运行时优先沿用 | `auth-config.json` | **高危 (High)** | 凭证安全 |
| **SEC-04** | 角色权限控制 (RBAC) 形同虚设，普通用户可全局控机与改名 | `server.js`, `auth-manager.js` | **中危 (Medium)** | 越权访问 |
| **ARC-01** | 多 Web 用户观看同设备时，一人退出导致**其他人被强制切断** | `server.js`, `scrcpy-console.c` | **高危 (High)** | 并发设计 |
| **ARC-02** | 多控制台场景下设备 Serial 碰撞导致**设备被无情遮蔽与串流** | `server.js` | **高危 (High)** | 路由寻址 |
| **ARC-03** | 多 Web 客户端同时操作产生触控竞争与幽灵手势 | `server.js`, `app.js` | **中危 (Medium)** | 并发控制 |
| **DOS-01** | 用户名级防爆破锁定引发**针对管理员的拒绝服务 (DoS)** | `auth-manager.js` | **中危 (Medium)** | 业务逻辑 |
| **DOS-02** | 高频触控/按键未限流导致控制台端 **ADB 子进程泛洪卡死** | `server.js`, `scrcpy-console.c` | **高危 (High)** | 拒绝服务 |
| **NET-01** | 缺少应用层心跳 Ping/Pong 导致网络假死与幽灵设备残留 | `server.js`, `scrcpy-console.c` | **中危 (Medium)** | 连接保活 |
| **PRT-01** | 控制台端手写 JSON 解析脆弱，存在缓冲区越界隐患 | `scrcpy-console.c` | **中危 (Medium)** | 协议鲁棒性 |
| **RTC-01** | WebRTC 信令单播映射缺陷，多客户端连接时相互覆盖失效 | `webrtc-signaling.js` | **中危 (Medium)** | 实时音视频 |

---

## 三、 详细审计发现

### 1. 认证与权限控制漏洞 (Authentication & Authorization)

#### 🔴 SEC-01: 控制台与设备控制通道完全无鉴权 (Critical)
- **代码定位**：`relay-server/server.js` 行 708-745
  ```javascript
  if (clientType === 'web') {
      // Web客户端始终需要认证
      sessionMiddleware(req, fakeRes, () => { ... });
  } else if (clientType === 'scrcpy' && serial) {
      if (pendingDeviceStreams.has(serial)) { ... }
      else { sessionMiddleware(req, fakeRes, () => { ... }); }
  } else {
      // 控制台连接不需要认证
      continueWebSocketConnection(ws, req, params, clientType, null);
  }
  ```
- **漏洞危害**：
  1. 任何人都可以发起 `ws://<server>/?type=console` 连接，伪造任意多个虚假 Android 设备（注入虚假 serial、机型名、离线/在线状态），导致后台充斥幽灵设备甚至引起 Web 前端渲染卡死。
  2. 当 `clientType === 'control'` 时，直接掉入 `else` 分支放行。攻击者只要知道 serial（Web 端设备列表公开可见），即可直接连接 `ws://<server>/?type=control&serial=xxxx` 劫持 `device.controlWs`，随意注入触控或按键。

#### 🔴 SEC-02: 跨站 WebSocket 劫持 (CSWSH) 导致全量手机被远程静默操控 (High)
- **代码定位**：`relay-server/server.js` 行 693-722
- **漏洞机理**：
  - Web 客户端升级 WebSocket 请求时仅校验 `req.headers.cookie` 中的 `scrcpy.sid`。
  - 服务端**完全没有检查 `Origin` 请求头**，并且 Cookie 未配置 `SameSite=Strict`。
- **攻击链路**：
  攻击者诱导已登录后台的管理员访问恶意网页 `https://evil.com`，恶意网页后台静默执行：
  ```javascript
  const ws = new WebSocket('wss://<server>:8443/?type=web');
  ```
  浏览器会自动携带管理员的认证 Cookie。攻击者即可通过脚本接收所有设备的截图缩略图、发起 `selectDevice` 查看手机画面、下发触控窃取验证码或转账。

#### 🔴 SEC-03: 仓库硬编码 Session Secret 导致签名伪造 (High)
- **代码定位**：`relay-server/auth-config.json` 第 11 行，`relay-server/server.js` 行 270-277
  ```javascript
  if (process.env.SESSION_SECRET) {
      sessionConfig.secret = process.env.SESSION_SECRET;
  } else if (!sessionConfig.secret || sessionConfig.secret.includes('change-this')) {
      sessionConfig.secret = crypto.randomBytes(32).toString('hex');
  }
  ```
- **漏洞危害**：
  `auth-config.json` 中已提交固定密钥 `"secret": "4f8eb39eed2b63e63ba18b31c4334f83b7a502b95e9812511e14cd3e449945aa"`。由于该值不含 `'change-this'`，未设置环境变量时直接沿用此泄露密钥。外部人员可离线直接伪造合法管理员 Session Cookie 越权登录。

#### 🟡 SEC-04: RBAC 鉴权缺失，普通用户拥有管理员完全权限 (Medium)
- **代码定位**：`relay-server/auth-manager.js` 行 110-118 与 `server.js` 各处
- **问题分析**：`auth-manager.js` 定义了 `requireRole(role)`，但全局没有任何一处路由或 WebSocket 指令调用了此方法。任何被赋予 `user` 角色的账号，登录后均可修改全局别名、修改设备分组、启动或关闭控制台推流，完全没有权限隔离。

---

### 2. 多客户端并发与多控制台路由冲突 (Concurrency & Multi-Console Routing)

#### 🔴 ARC-01: 多 Web 客户端观看同设备时的“互踢与断流”竞争 (High)
- **代码定位**：`relay-server/server.js` 行 1404-1434 (`case 'stopDevice'`)
  ```javascript
  case 'stopDevice':
      if (webClient.currentDevice) {
          ...
          removeViewerFromIndex(webClient.currentDevice, webClient.ws);
          const consoleClient = consoleClients.get(consoleId);
          if (consoleClient) {
              const device = consoleClient.devices.get(serial);
              if (device && device.viewerCount > 0) {
                  device.viewerCount--;
              }
              // 致命逻辑：未判断 viewerCount 是否为 0，无条件发送 stopDevice
              if (consoleClient.ws.readyState === WebSocket.OPEN) {
                  consoleClient.ws.send(JSON.stringify({ type: 'stopDevice', serial: serial }));
              }
          }
          webClient.currentDevice = null;
      }
      break;
  ```
- **影响**：
  若管理员 A 与管理员 B 同时查看设备 X，当管理员 A 切换设备或关闭窗口触发 `stopDevice` 时，服务端立即向控制台发送关闭指令，控制台杀掉 `scrcpy.exe`，导致管理员 B 画面瞬间被强制中断。
- **改进方向**：只有当 `device.viewerCount === 0` 时，才允许向控制台发送 `stopDevice`。

#### 🔴 ARC-02: 多控制台环境下设备 Serial 碰撞导致遮蔽与串流 (High)
- **代码定位**：`relay-server/server.js` 行 504-515, 586-624
  ```javascript
  function buildWebDeviceList() {
      const bySerial = new Map(); // serial -> { device, consoleId, priority }
      consoleClients.forEach((consoleClient, consoleId) => {
          consoleClient.devices.forEach((device, serial) => {
              const priority = getConsolePriority(consoleClient);
              const existing = bySerial.get(serial);
              if (!existing || priority >= existing.priority) {
                  bySerial.set(serial, { device, consoleId, priority });
              }
          });
      });
  ```
- **典型场景与故障**：
  1. 控制台 A (办公室 A) 与控制台 B (办公室 B) 分别运行了安卓模拟器（默认 `emulator-5554`），或者通过网络 ADB 调试各自局域网内的设备（如 `192.168.1.100:5555`）。
  2. `bySerial` 以 `serial` 为 Key，后连上的控制台会把先连上的设备**完全覆盖**，前端只能看到一台设备。
  3. `findDeviceBySerial(serial)` 会把 scrcpy 视频流推送到新控制台槽位，甚至在 Web 选机时直接重定向目标，引发跨控制台的严重“串流”。

#### 🟡 ARC-03: 缺少触控控制权抢占与互斥机制 (Medium)
- 多个 Web 端同时在同一个屏幕上拖动和点击时，所有触控事件无差别直连透传至 scrcpy，造成 Touch Down/Move/Up 序列交替错乱，引发设备端手势失真或误触。

---

### 3. 输入校验、命令执行与协议脆弱性 (Input Validation & Framing)

#### 🔴 DOS-02: 高频按键控制引发控制台端子进程泛洪 (High)
- **代码定位**：`scrcpy-console/scrcpy_console.c` 行 1379-1425 (`handle_server_message`)
- **分析**：
  在非 WebRTC 或回退模式下，收到 `action == "rotate"` 或 `action == "home"` 等按键时，控制台直接在 WebSocket 接收主循环中同步调用：
  ```c
  sprintf(adb_cmd, "-s %s shell input keyevent %s", serial, keycode);
  execute_adb_command(adb_cmd, output, sizeof(output)); // _popen
  ```
  若恶意客户端或脚本以 50~100 次/秒发送控制消息，控制台将短时间内派生上百个 `adb.exe` 进程，引发宿主系统卡死或崩溃。

#### 🟡 PRT-01: 控制台端手写 JSON 解析脆弱 (Medium)
- **代码定位**：`scrcpy-console/scrcpy_console.c` 行 1330-1375
- **分析**：
  使用简单的 `strstr` + `strncpy` 提取字符串，如果 `action_len` 异常（例如大于目标数组 `char action[64]`），未对最大长度做截断保护可能导致栈溢出；且若字段值中包含双引号或特殊结构，易引起解析错乱。

---

### 4. 拒绝服务与资源耗尽风险 (DoS & Resource Exhaustion)

#### 🟡 DOS-01: 基于用户名的防爆破锁定引发的反向管理员 DoS (Medium)
- **代码定位**：`relay-server/auth-manager.js` 行 39-56, 70-74
  ```javascript
  if (this.isLockedOut(username)) {
      return { success: false, message: '账户已锁定，请15分钟后再试' };
  }
  ```
- **分析**：锁定是以 `username` 为维度的全局 Map。攻击者只要每隔 15 分钟发送 5 次错误的管理员账号登录请求，真正的管理员就**永远无法登录系统**。锁定策略应当结合来源 IP 进行双重校验。

#### 🟡 NET-01: 缺乏 WebSocket 应用层 Ping/Pong 保活 (Medium)
- **代码定位**：`relay-server/server.js`
- **分析**：服务端未主动配置定期 ping 帧。当链路经过防火墙或云代理（如 Nginx `proxy_read_timeout 60s`）时，设备静止无画面时连接被中间件静默关闭，产生半开连接 (Half-Open Connection)，导致服务端设备列表不同步。

---

### 5. WebRTC 信令与多客户端适配缺陷 (WebRTC Signaling Issues)

#### 🟡 RTC-01: WebRTC 映射关系限制为单客户端 (Medium)
- **代码定位**：`relay-server/webrtc-signaling.js` 行 8, 73-76
- **分析**：`pendingConnections` 采用 `deviceId -> { offer, webWs }`。当多用户查看时，后一个用户的连接直接覆盖前一个，且死代码 `handleWebSelectDevice` 从未被 `server.js` 调用，导致 WebRTC 信令在多并发场景下无法正常工作。

---

## 四、 针对性整改与优化方案 (Remediation Plan)

### 阶段一：紧急安全加固 (Critical & High Severity)
1. **控制台预共享密钥认证 (Console Auth Token)**：
   - 增加环境变量 `CONSOLE_SECRET` 或在控制台启动参数中传递 Token。
   - `ws://<host>/?type=console&token=...`，服务端校验通过后才允许注册设备。
2. **防范 CSWSH 跨站劫持**：
   - 在 `server.js` 的 `handleWebSocketConnection` 中增加 `req.headers.origin` 校验，非同源或非白名单域名直接拒绝连接。
   - 配置 Session Cookie 的 `SameSite=Strict` 或 `SameSite=Lax`。
3. **修复多用户观看断流 Bug (ARC-01)**：
   - 在 `case 'stopDevice'` 处理中增加判定：仅当 `device.viewerCount === 0` 时才向控制台下发 `stopDevice`。
4. **废除硬编码 Session Secret**：
   - 在生产环境强制校验 `SESSION_SECRET` 环境变量，未提供时必须随机生成，禁止沿用默认值。

### 阶段二：多端路由与架构健壮性优化 (Medium Severity)
1. **全局设备唯一标识解耦**：
   - 彻底废除以单纯 `serial` 作为唯一设备 Key 的做法，全系统统一使用 `${consoleId}:${serial}` 作为主键，解决模拟器及相同内网 IP 的设备冲突遮蔽问题。
2. **控制指令速率限制与队列**：
   - 在服务端为每个 Web 客户端设置按键/旋转指令的 Throttle/Debounce（例如同类操作限制 200ms 最低间隔），防止控制台 ADB 进程爆炸。
3. **完善心跳保活机制**：
   - 服务端针对所有 WebSocket 连接引入每 30 秒一次的 `ws.ping()`，超时 10 秒未响应即断开重连，清理幽灵客户端。
4. **防爆破机制改造成 IP+用户名 双重限流**：
   - 改用 `express-rate-limit` 或在 `auth-manager` 中记录 `IP_username`，防止攻击者利用单用户名发起 DoS 瘫痪合法管理员。

---
*报告生成时间：2026-09-14*  
*审计报告版本：v1.0*
