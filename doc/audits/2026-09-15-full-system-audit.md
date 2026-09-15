# scrcpy-web 全系统代码审计报告

> **修复状态(2026-09-15 当日)**:本报告全部服务端发现(P1-1/P1-2/P2-3~7/P3-8~11)与 C 端发现(C-P0、C-P1-2/3 的 shutdown 顺序缓解、C-P2-5/7/8/9、C-P3-10~13)已修复并上线,见提交 `0c5baa8`、`bd99a64`、`4232c80`。**未修复/部分修复**:C-P1-3 的线程代次完整方案、C-P1-4(需与定制 scrcpy 构建协同下发一次性令牌)、C-P2-6(连接表读写锁重构)——均涉及跨进程/线程架构级改动,已记录待办。CONSOLE_TOKEN 已在服务端启用,**Windows 控制台须设置 `CONSOLE_TOKEN` 环境变量或以第二参数传入后重启,否则无法连接**。

- 日期:2026-09-15
- 范围:relay-server(Node.js)、scrcpy-console(Windows C 客户端)、部署面(Caddy / pm2 / Cloudflare Worker 中继)
- 方法:全量人工通读服务端约 6000 行 JS + C 端约 4400 行 C;对照既有审计报告(client-backend-communication-audit-2026-09-15.md、scrcpy-console-device-audit-report.md)查漏与验证修复落实
- 当前部署态:仅 Google 登录(ADMIN_EMAIL 单账号白名单)、ENABLE_HTTPS=true、Caddy 反代 443→8443、CONSOLE_TOKEN 未设置、TURN 未启用

---

## 一、结论摘要

整体架构与大部分安全设计是健康的:Google OAuth 有 state+PKCE+常数时间比较+白名单 fail-closed;WS 有 CSWSH Origin 校验、心跳、背压与控制限流;凭据已不再入库;149 个单元测试全绿。

但存在 **1 个 C 端远程栈溢出 P0(WebRTC 信令分支无边界 strncpy)**、**1 个高危配置缺失(CONSOLE_TOKEN 未设置导致控制台通道对公网开放)** 和 **1 个可被放大的内存 DoS(推流票据无限创建且永不回收)**;另有若干中等优先级的资源泄漏、竞态、数据丢失与权限问题。建议按下表顺序处理。

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| 0 | **P0** | WebRTC 信令分支无边界 strncpy,登录用户/中间人可远程栈溢出控制台 | scrcpy_console.c:1928-1931, 1998-2012 |
| 1 | **P1** | CONSOLE_TOKEN 未设置,控制台 WS 与推流预注册接口对公网完全开放 | server.js:642-653, 537-578 |
| 2 | **P1** | 推流票据无限创建且永不清理 → 内存 DoS | lib/helpers.js:166-221 |
| 3 | P2 | 服务器 .env 权限 644(含 Google ClientSecret 与中继密钥) | 服务器文件权限 |
| 4 | P2 | SESSION_SECRET 未固定,每次重启全员会话失效 | server.js:274-280 |
| 5 | P2 | 设备分组名 innerHTML 插值 → 存储型 XSS(当前仅自伤) | public/app.js:1368 |
| 6 | P2 | deviceAliases 加载时丢弃无冒号旧键 → 别名静默丢失 | server.js:175-190 |
| 7 | P2 | WebRTC pendingConnections 孤儿条目泄漏 | webrtc-signaling.js:8,78 |
| 8 | P3 | `device` clientType 死代码含无鉴权绑定逻辑 | server.js:972-1021 |
| 9 | P3 | handleWebSelectDevice / checkAuthStatic 死代码 | webrtc-signaling.js:262, server.js:516 |
| 10 | P3 | /api/* 无 HTTP 限速;webrtc-signaling 绕过日志级别直出 | server.js 装配层 |

---

## 二、P1 发现(建议立即处理)

### 1. 控制台通道对公网开放(CONSOLE_TOKEN 未设置)

**位置**:`relay-server/server.js:642-653`(console WS)、`server.js:537-578`(/api/prepare-device-stream)

**现状**:生产环境 ecosystem.config.js 未设置 `CONSOLE_TOKEN`(启动日志:"未配置 CONSOLE_TOKEN,控制台连接将使用免密兼容模式")。后果:

- 任何人可从公网发起 `wss://scrcpy.chuan.win/?type=console`(443 经 Caddy)或 `ws://42.193.18.13:8080/?type=console`(安全组已放行 8080)——server.js:644 `if (CONSOLE_TOKEN)` 为假,直接跳过校验,获得合法控制台身份;
- 可注入伪造 `deviceList`/`deviceUpdate`,伪造设备将出现在管理员浏览器中,并可走 `prepareStream` → 自己再开一条 `?type=scrcpy&ticket=...` 视频连接,向管理员播放任意内容(钓鱼);
- `/api/prepare-device-stream` 在无 CONSOLE_TOKEN 时鉴权条件短路(server.js:553),任何匿名请求都能为任意 consoleId/serial 创建推流票据;
- 管理员发出的 touch/control 指令会回放到攻击者的伪设备上(信息量低,但确认了双向可达)。

**修复建议**(低成本,强烈建议):
1. ecosystem.config.js env 增加 `CONSOLE_TOKEN: '<openssl rand -hex 32 生成>'`,并同步配置到 Windows 控制台;
2. 无 CONSOLE_TOKEN 时不再"免密兼容",直接拒绝 console 类型连接(fail closed);
3. /api/prepare-device-stream 在无 CONSOLE_TOKEN 时要求 Web 会话(当前已有 `req.session.user` 兜底,但条件逻辑应改为"必须提供 token 或有效会话",见 server.js:553 的短路问题)。

### 2. 推流票据无限创建且永不回收(内存 DoS)

**位置**:`relay-server/lib/helpers.js:166-221`(createStreamTicketRegistry)

`create()` 只增不减;`consume()` 仅在被访问时检查 TTL;从未被消费的票据(创建后 60 秒过期)没有任何后台清扫,永远留在 Map 中。叠加发现 1 的未鉴权入口:

```
while (true) fetch('/api/prepare-device-stream', {method:'POST', body:...})  // 匿名
```

即可让 tickets Map 无限增长,最终 OOM。即便配置了 CONSOLE_TOKEN,console 侧 `prepareStream` 产生的未消费票据同样缓慢累积。

**修复建议**:
1. 注册表内加定期清扫(`setInterval` 每 60 秒删除 `now - createdAt > ticketLifetimeMs` 的条目),或在 create 时顺带惰性清扫过期项;
2. 设置票据总量上限(如 1000,超限拒绝创建);
3. 落实发现 1 的鉴权后,匿名刷票据路径即被封死。

---

## 三、P2 发现

### 3. 服务器 .env 权限过宽

服务器 `~/scrcpy-web/relay-server/.env` 为 `-rw-r--r--`(644),内含 `GOOGLE_CLIENT_SECRET`、`SCRCPY_RELAY_KEY`。同目录 auth-config.json 已是 600。**修复:`chmod 600 ~/.scrcpy-web/relay-server/.env`**(一条命令,建议立即执行)。

### 4. SESSION_SECRET 未固定

server.js:274-280:未设置 `SESSION_SECRET` 时每次进程启动随机生成。每次 `pm2 restart`(即每次部署)后所有浏览器会话失效——这正是部署后日志大量出现"WebSocket 连接被拒绝: 无效会话"的原因;管理员需反复重新走 Google 登录。**修复:ecosystem.config.js env 中配置固定强随机 `SESSION_SECRET`**(auto-generated 值可保留为兜底)。附带收益:避免 MemoryStore 告警相关的重启频繁问题(会话仍为 MemoryStore,多实例不可用,当前单实例无碍)。

### 5. 设备分组名存储型 XSS

`public/app.js:1368`:

```js
groupTitle.innerHTML = `<span>${groupName}</span><span class="device-group-count">...`;
```

`groupName` 来自 `updateDeviceGroup` WS 消息(服务端仅 trim+截断 40 字符,未转义,server.js:1542),持久化在 device_groups.json 并广播给所有观看者。注入 `<img src=x onerror=...>` 即为存储型 XSS。**当前实际影响有限**:唯一能设置分组的是 ADMIN_EMAIL 白名单管理员本人(自伤型);但修复成本极低,且未来若放开多用户即成实际漏洞。**修复:改用 textContent/createElement**(设备名 customName 已经是 textContent 渲染,app.js:1298-1300,无此问题)。同类小问题:app.js:1382 用模板串拼 querySelector 选择器,serial 含 `"` 时查询失效(无 XSS,健壮性问题)。

### 6. deviceAliases 加载过滤导致别名静默丢失

server.js:181 加载与 200 行保存都只保留含 `:` 的键——旧格式(纯 serial 键,如 `02157df2818ba418`)的别名在加载时被丢入内存黑洞,下次任何一次别名保存就会把文件里的旧键**物理抹除**。这正是此前设备别名(殷紫萍/落红等)丢失的机制之一。**修复:要么写一次性迁移(旧 serial 键 → 新 `consoleId:serial` 键需要控制台在线才可补全,至少应保留原键),要么放开 `includes(':')` 过滤并在 buildWebDeviceList 时做兼容匹配。**

### 7. WebRTC pendingConnections 孤儿泄漏

webrtc-signaling.js:8/78:`handleOffer` 写入的条目仅在 `cleanupConnection`(设备级联清理/webrtc-disconnected)时删除。若 offer 发出后对端从未 answer/disconnect,条目(含 SDP 与缓存 candidates)永久驻留。量级小(需控制台在线),但与发现 2 同类。**修复:给注册表加 TTL 清扫,或在 handleOffer 时先清同 deviceId 旧条目。**

---

## 四、P3 发现(整洁度/纵深防御)

8. **`device` clientType 死代码**(server.js:972-1021):入口路由(handleWebSocketConnection)对非 web/console/control/scrcpy 类型一律拒绝(738-741),`continueWebSocketConnection` 的 `device` 分支不可达。该分支内部含"无鉴权绑定视频流"的逻辑,留着易在未来重构时被误接通。建议删除。
9. **死代码**:`handleWebSelectDevice`(webrtc-signaling.js:262,无调用方)、`checkAuthStatic`(server.js:516,无调用方)。
10. **/api/* 无 HTTP 层限速**:密码登录已禁用、Google 回调有 state 防滥用,当前风险低;若将来恢复密码登录,建议加 express-rate-limit(登录接口 5 次/分钟)。
11. **webrtc-signaling.js 全部使用 console.log 直出**(绕过 LOG_LEVEL 门控),生产日志里会混入大量 WebRTC 调试输出。
12. **直连 8443 自签证书路径仍然开放**(Caddy 已提供正规 443):可考虑安全组只对自家 IP 放行 8080/8443,或干脆关闭 8080 的公网入站(控制台走 443 + token 即可),收敛暴露面。

---

## 五、审计中确认的良好实践

- **认证**:Google OAuth state + PKCE(S256)+ 常数时间比较 + 10 分钟 TTL + 单邮箱白名单 fail-closed;拒绝信息不泄露期望账号(防枚举);密码登录有 bcrypt + IP 维度锁定(现仅本地模式使用)。
- **WebSocket**:web 类型 CSWSH Origin 校验;票据一次性、双通道分别消费、60 秒 TTL、控制台断开级联撤销;Offer/ICE 有设备所有权校验;Answer/ICE 有观看者资格校验;30 秒心跳 + terminate;控制指令 100ms 限流;观看者背压(8MiB/1MiB 水位 + 跳帧 + 关键帧请求)。
- **RBAC**:改名/分组仅 admin;设备列表对未认证者不可见。
- **客户端渲染**:设备名/模型均走 textContent;index.html 无 innerHTML sink;缩略图为 data URL。
- **供应链/凭据**:凭据与设备数据已全部移出 git;服务器上 auth-config.json 600;测试文件仅含 mock 值;单元测试 149 例全绿,helpers 纯函数化可测性良好。

---

## 六、修复优先级路线

1. **今天即可做**(纯配置,5 分钟):设置 `CONSOLE_TOKEN` + `SESSION_SECRET`(ecosystem.config.js),`chmod 600 .env`,重启 pm2 → 关闭发现 1/3/4。
2. **本周**(小改动):票据注册表 TTL 清扫 + 上限(helper 单测已有注入点,好写);分组名 textContent 渲染 → 关闭发现 2/5。
3. **顺手清理**:删除 device 分支与死代码、别名键兼容/迁移、pendingConnections TTL → 发现 6/7/8/9。

---

## 七、C 端(scrcpy-console)审计结果

审计范围:`scrcpy_console.c`(2737 行)、`local_video_relay.c`(1038 行)、`webrtc_support.c`(635 行)。基于两份既有报告只列**新问题**及**修复落实验证**。

### 修复落实验证

已确认落实:send_device_update_msg 动态 malloc+snprintf(旧堆溢出已消除)、设备变更检测、json_escape_string 控制字符转义、ADB 路径加引号、截图状态过滤、握手循环读取、recv_exact 与 64 位帧长校验、stopDevice/requestKeyFrame/updateDeviceName 字段截断。`ws_send_cs` 覆盖完整;`devices_cs` 有残余缺口(见 C-5)。

### C-P0:WebRTC 信令分支无边界 strncpy — 远程栈溢出

**位置**:`scrcpy_console.c:1928-1931`(webrtc-answer)、`1998-2012`(webrtc-ice-candidate)

```c
char device_id[256];
int len = device_id_end - device_id_start;   // 无上限检查(相邻分支均有 clamp)
strncpy(device_id, device_id_start, len);
device_id[len] = '\0';
// candidate[512] 同样未检查
```

**利用链已验证**:webrtc-signaling.js:213-222 将 Web 观看者提交的 candidate **原文转发**给控制台,前置条件仅为已登录且选看该设备;deviceId 形如 `console_<uuid>:serial`,超长 serial 或明文链路(控制台走 ws://8080)中间人注入即可溢出。build-mingw.sh 编译选项**无 -fstack-protector**,可覆盖返回地址。
**修复**:与相邻分支一致加 clamp(`if (len >= sizeof(buf)) len = sizeof(buf)-1;`),统一改用带限长提取函数;编译加 `-fstack-protector-strong`。

### C-P1

**C-2 每次断线重连泄漏一个缩略图线程**(scrcpy_console.c:352/1251/2206-2208):断线只 break 不置停止标志,旧线程 `while(running)` 永续,每 30 秒并发 8 路 ADB 截图并重复上报,随重连次数线性放大。修复:连接代次作为线程退出条件。

**C-3 本地中继 video_socket 跨线程 close 与 recv 竞态**(local_video_relay.c:638 vs 926/989;801-819):他线程 closesocket 正被 recv 阻塞的 socket 属 UB,句柄复用后旧线程从新连接读数据;同 serial 重连会双转发线程并发。修复:shutdown→closesocket 顺序 + 转发线程代次检查。

**C-4 本地中继完全无认证**(local_video_relay.c:356-435/746-829):本机任意进程连 127.0.0.1:37183 声称 `type=scrcpy&serial=<在线serial>` 即可顶掉真实 scrcpy 注入伪造画面;`type=control` 可窃听全部控制 JSON。修复:启动 scrcpy 时下发一次性令牌并在握手校验。

### C-P2

**C-5 devices_cs 残余缺口**(scrcpy_console.c:1266/1517-1542/1786-1787/1904-1909):缩略图线程无锁读 device_count;startDevice/updateDeviceName 分支无锁读写 devices[](当前写者在主线程,实害低但与 stop_device 已持锁写法不一致)。

**C-6 g_connections/local_clients 无同步 TOCTOU**(webrtc_support.c:55-81/481-544/590-599;local_video_relay.c:104-111 vs 119-140):`conn->dc` 检查后使用与并发置 -1/删除竞态;槽位复用使旧线程以新 serial 身份收发。修复:连接表读写锁 + 代次退出。

**C-7 接收缓冲 256KB < 帧上限 1MB → 大帧永久失步**(scrcpy_console.c:33/35/2212-2215):>256KB 合法帧永远凑不齐即清零缓冲,半截 payload 被误当帧头解析,可间接喂伪造控制消息;分片续帧(opcode 0)无分支被静默丢弃。修复:缓冲上限≥帧上限,溢出按整帧丢弃。

**C-8 connect_to_server 三连**(scrcpy_console.c:441-451/498/505-525):argv 端口段 `strcpy(port[16])` 溢出;握手失败不 closesocket 每轮泄漏连接;send 返回值忽略。

**C-9 恢复路径僵尸监听线程**(scrcpy_console.c:760-793;local_video_relay.c:751/921-944):stop 等待 1s 超时即放弃,旧线程存活时 init 重入 → 双线程 accept 同一 socket、并发占同一槽位。

### C-P3

**C-10** 初始化失败路径漏删 devices_cs/ws_send_cs(scrcpy_console.c:276-282)。**C-11** 未知 conn-type 先占槽后拒绝,8 个请求即耗尽 MAX_LOCAL_CLIENTS=8(local_video_relay.c:779-794)。**C-12** `system("taskkill /F /IM scrcpy.exe /T")` 误杀整机所有 scrcpy 进程(scrcpy_console.c:2089),应按记录的 process_id 逐个终止。**C-13** send_device_list 每设备 1024 字节预算 < 转义最坏长度(~1360B),长 serial+名称时整包静默放弃(scrcpy_console.c:1176-1205)。

---

## 八、总体修复优先级(合并两端)

| 优先级 | 事项 |
|--------|------|
| 立即 | 服务端:CONSOLE_TOKEN + SESSION_SECRET 配置、.env chmod 600(纯配置);C 端:C-P0 strncpy clamp + `-fstack-protector-strong` 重新编译 |
| 本周 | 票据 TTL 清扫+上限;分组名 XSS;C-2 线程泄漏;C-4 本地中继令牌 |
| 排期 | C-3/C-6/C-7/C-9 竞态与失步;别名键迁移;死代码清理 |

