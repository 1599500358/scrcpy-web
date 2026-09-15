# relay-server 单元测试

使用 Node.js 内置测试运行器（`node:test`，Node ≥ 20），零第三方测试依赖。

## 运行

```bash
cd relay-server
npm test
```

## 覆盖范围

| 文件 | 被测对象 |
|------|----------|
| `auth-manager.test.js` | 账号密码认证：配置加载/持久化、bcrypt 哈希、失败锁定与过期解锁、`authenticate`（含 IP 维度计数）、`hasRole`、`requireAuth`/`requireRole` 中间件、`addUser` |
| `google-auth.test.js` | Google OAuth：配置解析与 fail-closed、state/PKCE 生成、授权 URL 参数、常数时间比较、token 兑换（直连表单模式 + 中继 JSON 模式）、userinfo 请求 |
| `webrtc-signaling.test.js` | WebRTC 信令：Offer/Answer/ICE 转发、设备所有权与观看者授权校验、ICE 缓存补发、连接清理、TURN 配置与临时凭证 |
| `turn-server.test.js` | TURN：时间戳用户名/HMAC 凭证生成、初始化启停生命周期（含停止后配置清空）、未启用路径 |
| `helpers.test.js` | server.js 提取的纯逻辑：日志级别过滤、.env 解析、画质档位白名单、H.264 IDR 检测与 SPS/PPS 提取、`splitDeviceId`、CSWSH Origin 校验、推流票据（单次消费/过期/级联撤销）、控制命令节流、控制台优先级、设备查找（含无线 ADB IP 前缀匹配）、Web 设备列表组装 |

## 说明

- 涉及时间与随机数的逻辑（票据过期、节流间隔、TTL 时间戳）通过可注入的 `now` 函数测试，不依赖 sleep。
- 外部副作用一律替换：`fetch` 用 stub，WebSocket 用 `readyState`/`send` 假对象，文件系统用临时目录。
- `server.js` 的 HTTP 路由与连接处理属于集成测试范畴，此处不覆盖；纯逻辑已提取至 `lib/helpers.js` 并在此全量测试。
- 前端 `public/app.js` 顶层访问 `localStorage`/DOM，无法在 Node 中直接加载，不在本套件范围内。
