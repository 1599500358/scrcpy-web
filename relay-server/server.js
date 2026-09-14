const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const bodyParser = require('body-parser');
const AuthManager = require('./auth-manager');
const googleAuth = require('./google-auth');
const WebRTC = require('./webrtc-signaling');
const TurnServer = require('./turn-server');

// 加载 relay-server/.env（不覆盖已存在的环境变量），供 SESSION_SECRET /
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ADMIN_EMAIL / GOOGLE_REDIRECT_URI 等使用
function loadEnvFile(envPath) {
    try {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) continue;
            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    } catch (e) {
        // .env 不存在或不可读时静默跳过，外部环境变量仍然生效
    }
}
loadEnvFile(path.join(__dirname, '.env'));

// WebRTC 配置
const WEBRTC_ENABLED = process.env.WEBRTC_ENABLED !== 'false'; // 默认启用
const TURN_ENABLED = process.env.TURN_ENABLED === 'true'; // TURN 服务器开关
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_PORT = process.env.TURN_PORT || '3478';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const TURN_SECRET = process.env.TURN_SECRET || ''; // 用于生成临时凭证

// 日志级别控制
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'INFO'];
function log(level, ...args) {
    if (LOG_LEVELS[level] <= CURRENT_LOG_LEVEL) {
        const prefix = `[${new Date().toISOString()}] [${level}]`;
        if (level === 'ERROR') console.error(prefix, ...args);
        else if (level === 'WARN') console.warn(prefix, ...args);
        else console.log(prefix, ...args);
    }
}

// 控制台认证 Token（可选配置，未配置时输出提示）
const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN || '';
if (CONSOLE_TOKEN) {
    log('INFO', '[安全] 已启用控制台连接 Token 鉴权');
} else {
    log('WARN', '[安全] 未配置 CONSOLE_TOKEN，控制台连接将使用免密兼容模式（生产环境强烈建议配置）');
}

const app = express();
const authManager = new AuthManager(path.join(__dirname, 'auth-config.json'));

const MAX_WS_BUFFERED_AMOUNT = Number(process.env.MAX_WS_BUFFERED_AMOUNT || 8 * 1024 * 1024);
// 观看者发送积压阈值：超过该值跳过该观看者的普通帧并请求关键帧，
// 恢复带宽后从新 IDR 继续。默认 1MiB（约 4Mbps 下 2 秒排空量），远小于旧默认 8MiB
const VIEWER_MAX_BUFFERED_AMOUNT = Number(process.env.VIEWER_MAX_BUFFERED_AMOUNT || 1 * 1024 * 1024);
const ENABLE_VIDEO_LOG = process.env.ENABLE_VIDEO_LOG === 'true';
const IDLE_TIMEOUT = Number(process.env.IDLE_TIMEOUT || 300000); // 默认5分钟空闲超时（毫秒）

// 画质档位白名单（与控制台 VIDEO_PROFILES 保持一致）：
// 浏览器传入的 profile 仅作校验后的索引转发，不接收任意命令行参数
const VIDEO_PROFILES = new Set(['original', 'interactive', 'weaknet', 'sharp']);
function normalizeVideoProfile(profile) {
    return VIDEO_PROFILES.has(profile) ? profile : undefined;
}

// 检测 Annex-B H.264 数据中是否包含 IDR 帧（NAL type 5）。
// 编码器输出带 emulation prevention，NAL 负载内不会出现伪造的 00 00 01 起始码
function containsH264Idr(buf) {
    if (!Buffer.isBuffer(buf)) return false;
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 0 && buf[i + 1] === 0) {
            if (buf[i + 2] === 1) {
                if ((buf[i + 3] & 0x1F) === 5) return true;
                i += 2;
            } else if (buf[i + 2] === 0 && buf[i + 3] === 1) {
                if (i + 4 < buf.length && (buf[i + 4] & 0x1F) === 5) return true;
                i += 3;
            }
        }
    }
    return false;
}

// 观看者背压状态（ws -> { skipping, lastKeyframeReqAt }）
const viewerBackpressure = new WeakMap();

// 请求设备输出关键帧：优先轻量同步帧，经控制 WS 直达 scrcpy
function requestDeviceKeyframe(device, serial, forceReset = false) {
    const controlWs = device && device.controlWs;
    if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
        return false;
    }
    const action = forceReset ? 'resetVideo' : 'requestSyncFrame';
    try {
        controlWs.send(JSON.stringify({ type: 'control', serial, action }));
        log('INFO', `[关键帧] 已请求设备 ${serial} 关键帧 (${action})`);
        return true;
    } catch (e) {
        log('WARN', `[关键帧] 请求设备 ${serial} 关键帧失败:`, e.message);
        return false;
    }
}

// 双模式配置：同时支持 HTTP 和 HTTPS
const HTTP_PORT = process.env.HTTP_PORT || 8080;  // 本地 scrcpy 使用
const HTTPS_PORT = process.env.HTTPS_PORT || 8443; // 远程 Web 使用
const ENABLE_HTTPS = process.env.ENABLE_HTTPS === 'true' || false;

// 创建 HTTP 服务器（总是启用）
// 如果启用了 HTTPS，HTTP 端口只做两件事：1. WebSocket 连接 2. 其他请求重定向到 HTTPS
const httpApp = ENABLE_HTTPS ? express() : app;
if (ENABLE_HTTPS) {
    // HTTP 重定向中间件 - 将普通 HTTP 请求重定向到 HTTPS
    httpApp.use((req, res, next) => {
        // 如果是 WebSocket 升级请求，跳过重定向
        if (req.headers.upgrade === 'websocket') {
            return next();
        }
        // 否则重定向到 HTTPS
        const httpsUrl = `https://${req.headers.host.split(':')[0]}:${HTTPS_PORT}${req.url}`;
        res.redirect(301, httpsUrl);
    });
}

const httpServer = http.createServer(httpApp);
httpServer.on('connection', (socket) => {
    socket.setNoDelay(true);
});
const httpWss = new WebSocket.Server({ server: httpServer, perMessageDeflate: false });

// HTTPS 服务器（可选）
let httpsServer = null;
let httpsWss = null;

if (ENABLE_HTTPS) {
    const certPath = process.env.SSL_CERT_PATH || path.join(__dirname, 'cert', 'server.crt');
    const keyPath = process.env.SSL_KEY_PATH || path.join(__dirname, 'cert', 'server.key');
    
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        const httpsOptions = {
            cert: fs.readFileSync(certPath),
            key: fs.readFileSync(keyPath)
        };
        httpsServer = https.createServer(httpsOptions, app);
        httpsServer.on('connection', (socket) => {
            socket.setNoDelay(true);
        });
        httpsWss = new WebSocket.Server({ server: httpsServer, perMessageDeflate: false });
        log('INFO', '[HTTPS] SSL 证书已加载');
    } else {
        log('ERROR', '[HTTPS] SSL 证书文件不存在，请先生成证书');
        log('ERROR', `  证书路径: ${certPath}`);
        log('ERROR', `  密钥路径: ${keyPath}`);
        log('ERROR', '  运行: node generate-cert.js');
        process.exit(1);
    }
}

// 存储控制台客户端（家里的 Windows 电脑）
const consoleClients = new Map(); // clientId -> { ws, devices: Map }

// 存储 Web 浏览器客户端
const webClients = new Map(); // clientId -> { ws, currentDevice }

// 存储控制台预注册的设备推流（允许控制台启动的scrcpy连接）
const pendingDeviceStreams = new Map(); // serial -> consoleId

// 添加设备别名存储
const deviceAliases = new Map();
const deviceGroups = new Map();

// 加载设备别名
function loadDeviceAliases() {
    try {
        if (fs.existsSync('device_aliases.json')) {
            const data = fs.readFileSync('device_aliases.json', 'utf8');
            const aliases = JSON.parse(data);
            for (const [key, value] of Object.entries(aliases)) {
                deviceAliases.set(key, value);
            }
            console.log(`[设备别名] 已加载 ${deviceAliases.size} 个设备别名`);
        }
    } catch (err) {
        console.error('[设备别名] 加载设备别名失败:', err);
    }
}

// 保存设备别名（带 debounce，避免频繁写文件）
let _saveAliasesTimer = null;
function saveDeviceAliases() {
    if (_saveAliasesTimer) clearTimeout(_saveAliasesTimer);
    _saveAliasesTimer = setTimeout(() => {
        try {
            const aliases = {};
            deviceAliases.forEach((value, key) => {
                aliases[key] = value;
            });
            fs.writeFileSync('device_aliases.json', JSON.stringify(aliases, null, 2));
            log('INFO', '[设备别名] 设备别名已保存');
        } catch (err) {
            log('ERROR', '[设备别名] 保存设备别名失败:', err);
        }
    }, 1000); // 1秒内的多次修改合并为一次写入
}

// 初始化时加载设备别名
loadDeviceAliases();

// 加载设备分组
function loadDeviceGroups() {
    try {
        if (fs.existsSync('device_groups.json')) {
            const data = fs.readFileSync('device_groups.json', 'utf8');
            const groups = JSON.parse(data);
            for (const [serial, groupName] of Object.entries(groups)) {
                const normalized = typeof groupName === 'string' ? groupName.trim() : '';
                if (normalized) {
                    deviceGroups.set(serial, normalized);
                }
            }
            log('INFO', `[设备分组] 已加载 ${deviceGroups.size} 条分组记录`);
        }
    } catch (err) {
        log('ERROR', '[设备分组] 加载设备分组失败:', err);
    }
}

// 保存设备分组（带 debounce，避免频繁写文件）
let _saveGroupsTimer = null;
function saveDeviceGroups() {
    if (_saveGroupsTimer) clearTimeout(_saveGroupsTimer);
    _saveGroupsTimer = setTimeout(() => {
        try {
            const groups = {};
            deviceGroups.forEach((value, key) => {
                groups[key] = value;
            });
            fs.writeFileSync('device_groups.json', JSON.stringify(groups, null, 2));
            log('INFO', '[设备分组] 设备分组已保存');
        } catch (err) {
            log('ERROR', '[设备分组] 保存设备分组失败:', err);
        }
    }, 1000);
}

// 初始化时加载设备分组
loadDeviceGroups();

// 配置会话中间件
const sessionConfig = authManager.getSessionConfig();
// 根据是否启用HTTPS动态设置cookie安全属性
sessionConfig.cookie.secure = ENABLE_HTTPS;
sessionConfig.cookie.httpOnly = true; // 防止XSS窃取session cookie
sessionConfig.cookie.sameSite = sessionConfig.cookie.sameSite || 'lax'; // 防止CSRF
sessionConfig.name = 'scrcpy.sid'; // 设置会话cookie名称
sessionConfig.saveUninitialized = false;
sessionConfig.resave = false;

// 检查是否为已知的泄露或占位密钥
const LEAKED_SECRETS = new Set([
    '4f8eb39eed2b63e63ba18b31c4334f83b7a502b95e9812511e14cd3e449945aa',
    'change-this-in-production',
    'change-this'
]);

// session secret 优先从环境变量读取
if (process.env.SESSION_SECRET) {
    sessionConfig.secret = process.env.SESSION_SECRET;
} else if (!sessionConfig.secret || LEAKED_SECRETS.has(sessionConfig.secret) || sessionConfig.secret.includes('change-this')) {
    // 未提供安全环境变量时，自动生成256位高强度随机安全密钥
    sessionConfig.secret = crypto.randomBytes(32).toString('hex');
    log('WARN', '[安全] 未检测到安全的 SESSION_SECRET，已自动生成随机密钥');
}
const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);

// 解析请求体
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 认证检查中间件
function checkAuth(req, res, next) {
    if (req.session && req.session.user) {
        next();
    } else {
        if (req.path === '/login' || req.path === '/api/login') {
            next();
        } else {
            res.redirect('/login');
        }
    }
}

// 登录页面路由
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 登录API
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ success: false, message: '请提供用户名和密码' });
    }
    
    try {
        const clientIp = req.ip || req.connection?.remoteAddress || '';
        const result = await authManager.authenticate(username, password, clientIp);
        if (result.success) {
            req.session.user = result.user;
            req.session.loginTime = new Date().toISOString();
            
            // 显式保存会话
            req.session.save((err) => {
                if (err) {
                    log('ERROR', '会话保存错误:', err);
                    return res.status(500).json({ success: false, message: '会话保存失败' });
                }
                log('INFO', '会话已保存，用户:', result.user.username);
                log('INFO', '登录会话ID:', req.sessionID);
                res.json({ success: true, message: '登录成功' });
            });
        } else {
            res.status(401).json(result);
        }
    } catch (error) {
        log('ERROR', '登录错误:', error);
        res.status(500).json({ success: false, message: '服务器错误' });
    }
});

// 登出API
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            log('ERROR', '登出错误:', err);
            res.status(500).json({ success: false, message: '登出失败' });
        } else {
            res.json({ success: true, message: '登出成功' });
        }
    });
});

// 获取当前用户信息
app.get('/api/user', authManager.requireAuth, (req, res) => {
    res.json({ user: req.session.user });
});

// ============ Google OAuth 登录（移植自 photo 项目，同一管理员白名单） ============

// 从当前请求推导回调地址（生产环境建议用 GOOGLE_REDIRECT_URI 显式指定）
function deriveGoogleRedirectUri(req) {
    return `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
}

// 登录页查询 Google 登录是否可用（决定是否展示按钮）
app.get('/api/auth/google/status', (req, res) => {
    res.json({ enabled: googleAuth.isGoogleOAuthConfigured() });
});

// 发起 Google 登录：生成 state + PKCE 暂存到会话后跳转 Google
app.get('/api/auth/google', (req, res) => {
    const cfg = googleAuth.getGoogleOAuthConfig();
    if (!googleAuth.isGoogleOAuthConfigured()) {
        return res.redirect('/login?error=' + encodeURIComponent('Google 登录未配置：缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ADMIN_EMAIL'));
    }

    const state = googleAuth.generateState();
    const { verifier, challenge } = googleAuth.generatePkcePair();
    // state/PKCE 存入当前会话（10 分钟有效），回调时比对
    req.session.oauth = { state, verifier, createdAt: Date.now() };

    res.redirect(googleAuth.getGoogleAuthUrl({
        clientId: cfg.clientId,
        redirectUri: cfg.redirectUri || deriveGoogleRedirectUri(req),
        state,
        codeChallenge: challenge
    }));
});

// Google 回调：校验 state → 兑换 token → 拉取用户信息 → 白名单校验 → 写入会话
app.get('/api/auth/google/callback', async (req, res) => {
    const cfg = googleAuth.getGoogleOAuthConfig();
    const oauth = req.session && req.session.oauth;
    delete req.session.oauth;

    const fail = (message) => res.redirect('/login?error=' + encodeURIComponent(message));

    if (!googleAuth.isGoogleOAuthConfigured()) {
        return fail('Google 登录未配置');
    }

    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
        log('WARN', '[Google登录] 用户取消或授权失败:', oauthError);
        return fail('Google 授权被取消或失败，请重试');
    }

    // state 比对（CSRF 防护）+ 有效期校验
    const OAUTH_FLOW_TTL = 10 * 60 * 1000;
    if (!code || !state || !oauth || !oauth.state ||
        !googleAuth.timingSafeEqualStr(state, oauth.state) ||
        !oauth.createdAt || Date.now() - oauth.createdAt > OAUTH_FLOW_TTL) {
        log('WARN', '[Google登录] state 校验失败或流程已过期');
        return fail('会话状态校验失败或已过期，请重新发起登录');
    }

    try {
        const tokenRes = await googleAuth.exchangeGoogleCode({
            code,
            clientId: cfg.clientId,
            clientSecret: cfg.clientSecret,
            redirectUri: cfg.redirectUri || deriveGoogleRedirectUri(req),
            codeVerifier: oauth.verifier
        });
        const userInfo = await googleAuth.getGoogleUserInfo(tokenRes.access_token);
        const email = (userInfo.email || '').toLowerCase();

        // 严格白名单：与 photo 项目一致，仅允许单一管理员邮箱；
        // 拒绝时不提示期望的账号，防止账号枚举
        if (!email || email !== cfg.adminEmail) {
            log('WARN', `[Google登录] 非白名单账号被拒绝: ${email || '(无邮箱)'}`);
            return fail('当前 Google 账号未获得此系统的授权');
        }

        req.session.user = {
            username: email,
            role: 'admin',
            authProvider: 'google',
            name: userInfo.name || email.split('@')[0],
            avatar: userInfo.picture || ''
        };
        req.session.loginTime = new Date().toISOString();
        req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // Google 会话保持 7 天（与 photo 一致）

        log('INFO', `[Google登录] 登录成功: ${email}`);
        res.redirect('/');
    } catch (err) {
        log('ERROR', '[Google登录] 回调处理失败:', err.message);
        fail('登录流程出现问题，请稍后重试');
    }
});

// API: 获取 WebRTC 配置（包括 TURN 凭证）
app.get('/api/webrtc-config', authManager.requireAuth, (req, res) => {
    const config = {
        enabled: WEBRTC_ENABLED,
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    // 如果配置了 TURN 服务器
    if (TURN_HOST && (TURN_USERNAME || TURN_SECRET)) {
        let turnUsername = TURN_USERNAME;
        let turnCredential = TURN_CREDENTIAL;

        // 如果使用密钥生成临时凭证
        if (TURN_SECRET && !TURN_USERNAME) {
            const creds = WebRTC.generateTurnCredentials(TURN_SECRET, 86400); // 24小时有效
            turnUsername = creds.username;
            turnCredential = creds.credential;
        }

        if (turnUsername && turnCredential) {
            config.iceServers.push({
                urls: `turn:${TURN_HOST}:${TURN_PORT}`,
                username: turnUsername,
                credential: turnCredential
            });
            // 同时添加 TURN TLS（如果端口是 5349）
            if (TURN_PORT === '5349' || TURN_PORT === 5349) {
                config.iceServers.push({
                    urls: `turns:${TURN_HOST}:5349`,
                    username: turnUsername,
                    credential: turnCredential
                });
            }
        }
    }

    res.json(config);
});

// 公开访问的静态资源（登录页和相关资源）
app.use('/login', express.static(path.join(__dirname, 'public', 'login.html')));

// 公开访问的静态资源文件（CSS、JS、图片等不需要认证）
app.use(express.static(path.join(__dirname, 'public'), {
    // 对 HTML 文件特殊处理：需要认证
    setHeaders: (res, path) => {
        if (path.endsWith('.html') && !path.includes('login')) {
            // HTML 文件会在后续路由中处理认证
        }
    }
}));

// 检查是否为已登录用户的中间件（用于静态文件）
function checkAuthStatic(req, res, next) {
    if (req.session && req.session.user) {
        next();
    } else {
        // 未登录，重定向到登录页
        res.redirect('/login');
    }
}

// 需要认证的特定路由
// 主页路由（需要认证）
app.get('/', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// index.html 需要认证
app.get('/index.html', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: 控制台预注册设备推流（需要验证控制台身份）
app.post('/api/prepare-device-stream', (req, res) => {
    const { serial, consoleId } = req.body;
    
    if (!serial || !consoleId) {
        return res.status(400).json({ 
            success: false, 
            message: '缺少参数: serial 和 consoleId 是必需的' 
        });
    }
    
    // 验证控制台是否存在
    if (!consoleClients.has(consoleId)) {
        return res.status(404).json({ 
            success: false, 
            message: '控制台不存在' 
        });
    }
    
    // 验证请求来源IP是否与控制台连接IP一致
    const consoleClient = consoleClients.get(consoleId);
    const requestIp = req.ip || req.connection.remoteAddress;
    const consoleIp = consoleClient.remoteAddress;
    if (consoleIp && requestIp && !requestIp.includes('127.0.0.1') && !requestIp.includes('::1') && requestIp !== consoleIp) {
        log('WARN', `[预注册] IP不匹配: 请求=${requestIp}, 控制台=${consoleIp}`);
        return res.status(403).json({
            success: false,
            message: '来源验证失败'
        });
    }
    
    // 预注册设备推流
    pendingDeviceStreams.set(serial, consoleId);
    log('INFO', `[预注册] 控制台${consoleId}预注册设备${serial}的推流`);
    
    res.json({ 
        success: true, 
        message: '设备推流已预注册' 
    });
});

// API: 获取所有可用设备列表（需要认证）
app.get('/api/devices', authManager.requireAuth, (req, res) => {
    const allDevices = [];
    consoleClients.forEach((client, clientId) => {
        client.devices.forEach((device, serial) => {
            allDevices.push({
                ...device,
                consoleId: clientId
            });
        });
    });
    res.json(allDevices);
});

// 辅助函数：查找设备（支持 IP 地址模糊匹配）
function getConsolePriority(consoleClient) {
    const isOpen = !!(consoleClient && consoleClient.ws && consoleClient.ws.readyState === WebSocket.OPEN);
    const connectedAtMs = Date.parse(consoleClient?.connectedAt || '') || 0;
    return (isOpen ? 1e15 : 0) + connectedAtMs;
}

function findDeviceBySerial(serial, preferredConsoleId = null) {
    // 优先匹配指定控制台
    if (preferredConsoleId && consoleClients.has(preferredConsoleId)) {
        const consoleClient = consoleClients.get(preferredConsoleId);
        if (consoleClient.devices.has(serial)) {
            return {
                device: consoleClient.devices.get(serial),
                consoleId: preferredConsoleId,
                serial: serial
            };
        }
    }

    let bestMatch = null;

    function considerCandidate(consoleClient, consoleId, deviceSerial, device) {
        const priority = getConsolePriority(consoleClient);
        if (!bestMatch || priority >= bestMatch.priority) {
            bestMatch = {
                device,
                consoleId,
                serial: deviceSerial,
                priority
            };
        }
    }

    consoleClients.forEach((consoleClient, consoleId) => {
        if (consoleClient.devices.has(serial)) {
            considerCandidate(consoleClient, consoleId, serial, consoleClient.devices.get(serial));
        }

        if (serial && serial.match(/^\d+\.\d+\.\d+\.\d+$/)) {
            consoleClient.devices.forEach((device, deviceSerial) => {
                if (deviceSerial.startsWith(serial + ':')) {
                    considerCandidate(consoleClient, consoleId, deviceSerial, device);
                }
            });
        }
    });

    if (bestMatch) {
        return {
            device: bestMatch.device,
            consoleId: bestMatch.consoleId,
            serial: bestMatch.serial
        };
    }

    return { device: null, consoleId: null, serial: null };
}

function buildWebDeviceList() {
    const allDevices = [];

    consoleClients.forEach((consoleClient, consoleId) => {
        if (!consoleClient.ws || consoleClient.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        consoleClient.devices.forEach((device, serial) => {
            const deviceId = `${consoleId}:${serial}`;
            const deviceInfo = {
                id: deviceId,
                serial: device.serial || serial,
                model: device.model,
                state: device.state,
                status: device.status,
                consoleId
            };

            if (device.thumbnail) {
                deviceInfo.thumbnail = device.thumbnail;
                log('DEBUG', `[WS] 发送设备 ${deviceId} 缩略图数据，长度: ${device.thumbnail.length}`);
            }

            if (deviceAliases.has(deviceId)) {
                deviceInfo.customName = deviceAliases.get(deviceId);
            } else if (deviceAliases.has(serial)) {
                deviceInfo.customName = deviceAliases.get(serial);
            } else if (device.customName) {
                deviceInfo.customName = device.customName;
            }

            const groupName = deviceGroups.get(deviceId) || deviceGroups.get(serial) || device.groupName;
            if (groupName && String(groupName).trim()) {
                deviceInfo.groupName = String(groupName).trim();
            }

            allDevices.push(deviceInfo);
        });
    });

    return allDevices;
}

// 辅助函数：拆分设备 ID（支持带端口的 IP 地址）
function splitDeviceId(deviceId) {
    if (!deviceId) return ['', ''];
    const colonIndex = deviceId.indexOf(':');
    if (colonIndex === -1) {
        // 无冒号时表示仅传入了设备 serial（向后兼容旧前端）
        return ['', deviceId];
    }
    return [
        deviceId.substring(0, colonIndex),
        deviceId.substring(colonIndex + 1)
    ];
}

function sendWsJson(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

// 检查 WebSocket 升级请求的 Origin（防范 CSWSH 跨站劫持）
function isAllowedWsOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) {
        // 非浏览器客户端（如本地 C 客户端、Node 脚本）不带 Origin，放行
        return true;
    }
    const host = req.headers.host;
    if (!host) return false;
    try {
        const parsedOrigin = new URL(origin);
        // 主机名相同即同源（忽略协议是 http 还是 https，兼容反向代理）
        if (parsedOrigin.host === host || parsedOrigin.hostname === host.split(':')[0]) {
            return true;
        }
        if (process.env.ALLOWED_ORIGINS) {
            const allowed = process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim().toLowerCase());
            if (allowed.includes(parsedOrigin.origin.toLowerCase()) || allowed.includes(parsedOrigin.host.toLowerCase())) {
                return true;
            }
        }
        return false;
    } catch (e) {
        return false;
    }
}

// WebSocket 连接处理函数（共用）
function handleWebSocketConnection(ws, req) {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const clientType = params.get('type'); // 'console', 'scrcpy', 'control' 或 'web'
    const serial = params.get('serial');
    
    // 为 WebSocket upgrade 请求创建模拟 response 对象
    // express-session 需要 res 上有 writeHead/end/on 等方法
    const fakeRes = {
        writeHead: () => {},
        end: () => {},
        on: () => {},
        getHeader: () => {},
        setHeader: () => {}
    };
    
    // 检查WebSocket连接是否需要认证
    if (clientType === 'web') {
        // 校验 Origin 防止 CSWSH
        if (!isAllowedWsOrigin(req)) {
            log('WARN', `[安全] 拦截跨站 WebSocket 劫持 (CSWSH): Origin=${req.headers.origin}, Host=${req.headers.host}`);
            ws.close(1008, '跨站访问被拒绝 (CSWSH)');
            return;
        }

        // Web客户端始终需要认证
        log('INFO', `[认证] WebSocket upgrade cookies: ${req.headers.cookie || '(none)'}`);
        sessionMiddleware(req, fakeRes, () => {
            log('INFO', `[认证] session解析完成, sessionID: ${req.sessionID}, hasUser: ${!!(req.session && req.session.user)}, keys: ${req.session ? Object.keys(req.session).join(',') : 'null'}`);
            if (req.session && req.session.user) {
                log('INFO', `[认证] WebSocket连接已授权: ${req.session.user.username}`);
                continueWebSocketConnection(ws, req, params, clientType, req.session.user);
            } else {
                log('WARN', `[认证] WebSocket连接被拒绝: 无效会话`);
                ws.close(1008, '未授权访问');
            }
        });
    } else if (clientType === 'console') {
        // 控制台连接：若配置了 CONSOLE_TOKEN 则强制校验
        if (CONSOLE_TOKEN) {
            const token = params.get('token');
            if (!token || token !== CONSOLE_TOKEN) {
                log('WARN', `[安全] 控制台身份验证失败: Token 不匹配 (来源 IP: ${req.socket.remoteAddress})`);
                ws.close(1008, '控制台 Token 认证失败');
                return;
            }
            log('INFO', `[认证] 控制台 Token 验证通过`);
        }
        continueWebSocketConnection(ws, req, params, clientType, null);
    } else if (clientType === 'control') {
        // 控制连接：必须校验 serial 并确保对应设备已在某个控制台注册
        const controlSerial = params.get('serial');
        if (!controlSerial) {
            log('WARN', '[scrcpy-control] 连接被拒绝: 缺少 serial');
            ws.close(1008, '缺少 serial');
            return;
        }
        const lookup = findDeviceBySerial(controlSerial);
        if (!lookup.device) {
            log('WARN', `[scrcpy-control] 连接被拒绝: 设备 ${controlSerial} 未注册`);
            ws.close(1008, '设备未注册');
            return;
        }
        continueWebSocketConnection(ws, req, params, clientType, null);
    } else if (clientType === 'scrcpy' && serial) {
        // scrcpy连接：检查是否是控制台预注册的设备
        if (pendingDeviceStreams.has(serial)) {
            const consoleId = pendingDeviceStreams.get(serial);
            log('INFO', `[认证] scrcpy连接已授权: 设备${serial}由控制台${consoleId}预注册`);
            pendingDeviceStreams.delete(serial); // 使用一次后删除
            continueWebSocketConnection(ws, req, params, clientType, null);
        } else {
            // 未预注册的设备需要认证
            sessionMiddleware(req, fakeRes, () => {
                if (req.session && req.session.user) {
                    log('INFO', `[认证] scrcpy连接已授权: ${req.session.user.username}`);
                    continueWebSocketConnection(ws, req, params, clientType, req.session.user);
                } else {
                    log('WARN', `[认证] scrcpy连接被拒绝: 无效会话`);
                    ws.close(1008, '未授权访问');
                }
            });
        }
    } else {
        // 其他非授权类型拒绝
        log('WARN', `[安全] 未知或未授权的连接类型: ${clientType}`);
        ws.close(1008, '未授权访问');
    }
}

// 继续WebSocket连接处理
function continueWebSocketConnection(ws, req, params, clientType, user) {
    
    log('INFO', `[连接] 新连接: type=${clientType}`);
    
    if (clientType === 'console') {
        // Windows 控制台客户端连接
        const clientId = `console_${crypto.randomUUID()}`;
        consoleClients.set(clientId, {
            ws,
            devices: new Map(),
            connectedAt: new Date().toISOString(),
            remoteAddress: req.socket.remoteAddress // 保存连接IP用于认证
        });
        
        log('INFO', `[控制台] 已注册: ${clientId}`);
        
        // 发送欢迎消息，包含控制台ID
        ws.send(JSON.stringify({
            type: 'welcome',
            clientId: clientId,
            message: '已连接到中继服务器'
        }));
        
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                handleConsoleMessage(clientId, msg);
            } catch (e) {
                log('ERROR', '[控制台] 消息解析错误:', e);
            }
        });
        
        ws.on('close', () => {
            consoleClients.delete(clientId);
            log('INFO', `[控制台] 已断开: ${clientId}`);
            broadcastDeviceListToWeb();
        });
        
    } else if (clientType === 'scrcpy') {
        // scrcpy 视频连接
        const serial = params.get('serial');
        
        if (!serial) {
            log('WARN', '[scrcpy-video] 连接被拒绝: 缺少 serial');
            ws.close();
            return;
        }
        
        log('INFO', `[scrcpy-video] 设备 ${serial} 视频流已连接`);
        
        // 使用辅助函数查找设备（支持 IP 地址模糊匹配）
        const result = findDeviceBySerial(serial);
        let foundDevice = result.device;
        let foundConsoleId = result.consoleId;
        const matchedSerial = result.serial;
        
        // 构建此设备的查找键（用于视频转发索引）
        const deviceKey = foundConsoleId && matchedSerial ? `${foundConsoleId}:${matchedSerial}` : null;
        
        if (foundDevice) {
            foundDevice.videoWs = ws; // 保存视频 WebSocket 连接
            foundDevice.status = 'streaming';
            foundDevice.viewerCount = 0; // 初始化观看者数量
            foundDevice.lastActivityTime = Date.now(); // 初始化最后活动时间
            foundDevice.deviceKey = deviceKey; // 保存索引键
            
            log('INFO', `[scrcpy-video] 找到设备所属控制台: ${foundConsoleId}, 匹配序列号: ${matchedSerial}`);
            
            // 通知控制台
            const consoleClient = consoleClients.get(foundConsoleId);
            if (consoleClient) {
                consoleClient.ws.send(JSON.stringify({
                    type: 'deviceStreamingStarted',
                    serial: matchedSerial
                }));
            }
        } else {
            log('WARN', `[scrcpy-video] 警告: 设备 ${serial} 不在任何控制台的设备列表中`);
        }
        
        // 接收并转发视频数据（透明转发，不修改数据）
        ws.on('message', (data) => {
            if (Buffer.isBuffer(data) && foundDevice) {
                // 更新设备最后活动时间
                foundDevice.lastActivityTime = Date.now();

                const isIdr = containsH264Idr(data);

                // 使用观看者索引快速查找（O(1) 而非遍历所有客户端）
                const viewers = deviceKey ? deviceViewerIndex.get(deviceKey) : null;
                let viewerCount = 0;
                if (viewers && viewers.size > 0) {
                    for (const viewerWs of viewers) {
                        if (viewerWs.readyState === WebSocket.OPEN) {
                            // 每个观看者独立管理队列：慢观看者不拖累其他观看者
                            let bp = viewerBackpressure.get(viewerWs);
                            if (!bp) {
                                bp = { skipping: false, lastKeyframeReqAt: 0 };
                                viewerBackpressure.set(viewerWs, bp);
                            }

                            if (!bp.skipping && viewerWs.bufferedAmount > VIEWER_MAX_BUFFERED_AMOUNT) {
                                bp.skipping = true;
                                bp.lastKeyframeReqAt = Date.now();
                                log('WARN', `[视频转发] 观看者积压 ${viewerWs.bufferedAmount} 字节，跳过普通帧等待关键帧`);
                                requestDeviceKeyframe(foundDevice, matchedSerial || serial);
                            }

                            if (bp.skipping) {
                                // 关键帧请求长时间未生效时回退完整重置一次（旧 scrcpy 兼容）
                                if (Date.now() - bp.lastKeyframeReqAt > 5000) {
                                    bp.lastKeyframeReqAt = Date.now();
                                    log('WARN', '[视频转发] 同步帧请求未生效，回退完整重置');
                                    requestDeviceKeyframe(foundDevice, matchedSerial || serial, true);
                                }
                                if (isIdr) {
                                    // 从新关键帧恢复发送
                                    bp.skipping = false;
                                } else {
                                    continue;
                                }
                            }

                            if (viewerWs.bufferedAmount <= MAX_WS_BUFFERED_AMOUNT) {
                                viewerWs.send(data, { binary: true, compress: false });
                                viewerCount++;
                            }
                        }
                    }
                } else {
                    // 降级：索引中找不到时遍历（兼容旧匹配方式）
                    webClients.forEach((client) => {
                        const matchDevice = client.currentDevice === `${foundConsoleId}:${matchedSerial}` ||
                                           client.currentDevice === `${foundConsoleId}:${serial}` ||
                                           client.currentDevice === matchedSerial ||
                                           client.currentDevice === serial;
                        if (matchDevice && client.ws.readyState === WebSocket.OPEN) {
                            if (client.ws.bufferedAmount <= MAX_WS_BUFFERED_AMOUNT) {
                                client.ws.send(data, { binary: true, compress: false });
                                viewerCount++;
                            }
                        }
                    });
                }

                // 更新观看者数量
                foundDevice.viewerCount = viewerCount;
            }
        });
        ws.on('error', (err) => {
            log('ERROR', `[scrcpy-video] 设备 ${serial} 连接错误:`, err);
        });
        
        ws.on('close', (code, reason) => {
            if (foundDevice) {
                foundDevice.videoWs = null;
                foundDevice.status = 'ready';
                log('INFO', `[scrcpy-video] 设备 ${serial} 视频流已断开，code=${code} reason=${reason}`);
                broadcastDeviceListToWeb();
            }
        });
        
    } else if (clientType === 'control') {
        // scrcpy 控制连接
        const serial = params.get('serial');
        
        if (!serial) {
            log('WARN', '[scrcpy-control] 连接被拒绝: 缺少 serial');
            ws.close();
            return;
        }
        
        log('INFO', `[scrcpy-control] 设备 ${serial} 控制连接已建立`);
        
        // 使用辅助函数查找设备（支持 IP 地址模糊匹配）
        const result = findDeviceBySerial(serial);
        let foundDevice = result.device;
        let foundConsoleId = result.consoleId;
        const matchedSerial = result.serial;
        
        if (foundDevice) {
            foundDevice.controlWs = ws; // 保存控制 WebSocket 连接
            log('INFO', `[scrcpy-control] 找到设备所属控制台: ${foundConsoleId}, 匹配序列号: ${matchedSerial}`);
        } else {
            log('WARN', `[scrcpy-control] 警告: 设备 ${serial} 不在任何控制台的设备列表中`);
        }
        
        // 不需要接收数据，只用于发送控制消息
        
        ws.on('close', (code, reason) => {
            if (foundDevice) {
                foundDevice.controlWs = null;
                log('INFO', `[scrcpy-control] 设备 ${serial} 控制连接已断开，code=${code} reason=${reason}`);
            }
        });
        
    } else if (clientType === 'device') {
        // scrcpy 设备视频流连接
        const serial = params.get('serial');
        const consoleId = params.get('consoleId');
        
        if (!serial || !consoleId) {
            log('WARN', '[设备] 连接被拒绝: 缺少 serial 或 consoleId');
            ws.close();
            return;
        }
        
        const consoleClient = consoleClients.get(consoleId);
        if (!consoleClient) {
            log('WARN', `[设备] 连接被拒绝: 控制台 ${consoleId} 不存在`);
            ws.close();
            return;
        }
        
        const device = consoleClient.devices.get(serial);
        if (device) {
            device.videoWs = ws;
            device.status = 'streaming';
            log('INFO', `[设备] ${serial} 视频流已连接`);
            
            // 通知控制台
            consoleClient.ws.send(JSON.stringify({
                type: 'deviceStreamingStarted',
                serial: serial
            }));
        }
        
        ws.on('message', (data) => {
            webClients.forEach((client) => {
                if (client.currentDevice === `${consoleId}:${serial}` && 
                    client.ws.readyState === WebSocket.OPEN) {
                    if (client.ws.bufferedAmount <= MAX_WS_BUFFERED_AMOUNT) {
                        client.ws.send(data, { binary: true, compress: false });
                    }
                }
            });
        });
        
        ws.on('close', () => {
            if (device) {
                device.videoWs = null;
                device.status = 'ready';
                log('INFO', `[设备] ${serial} 视频流已断开`);
            }
        });
        
    } else if (clientType === 'web') {
        // Web 浏览器客户端连接
        const clientId = `web_${crypto.randomUUID()}`;
        webClients.set(clientId, {
            ws,
            currentDevice: null,
            user: user || null
        });
        
        log('INFO', `[Web客户端] 已连接: ${clientId}`);
        
        // 发送当前可用设备列表
        sendDeviceListToWeb(ws);
        
        ws.on('message', (message) => {
            try {
                const msg = JSON.parse(message);
                handleWebMessage(clientId, msg);
            } catch (e) {
                log('ERROR', '[Web客户端] 消息解析错误:', e);
            }
        });
        
        ws.on('close', () => {
            // 如果该客户端正在观看设备，从观看者索引中移除并更新计数
            const webClient = webClients.get(clientId);
            if (webClient && webClient.currentDevice) {
                removeViewerFromIndex(webClient.currentDevice, webClient.ws);
                const [consoleId, serial] = splitDeviceId(webClient.currentDevice);
                const consoleClient = consoleClients.get(consoleId);
                if (consoleClient) {
                    const device = consoleClient.devices.get(serial);
                    if (device && device.viewerCount > 0) {
                        device.viewerCount--;
                        log('INFO', `[Web客户端] ${clientId} 断开，设备 ${serial} 剩余观看者: ${device.viewerCount}`);
                    }
                }
            }
            
            webClients.delete(clientId);
            log('INFO', `[Web客户端] 已断开: ${clientId}`);
        });
    }
}

// 应用 WebSocket 处理到 HTTP 服务器
httpWss.on('connection', handleWebSocketConnection);

// 如果启用了 HTTPS，也应用到 HTTPS 服务器
if (ENABLE_HTTPS && httpsWss) {
    httpsWss.on('connection', handleWebSocketConnection);
}

// 处理控制台消息
function handleConsoleMessage(consoleId, msg) {
    const consoleClient = consoleClients.get(consoleId);
    if (!consoleClient) return;
    
    switch (msg.type) {
        case 'deviceList':
            // 更新设备列表
            const oldDevices = consoleClient.devices;
            consoleClient.devices = new Map();
            
            msg.devices.forEach((incomingDevice) => {
                const oldDevice = oldDevices.get(incomingDevice.serial);
                const aliasName = deviceAliases.get(incomingDevice.serial);
                const preservedName = aliasName || oldDevice?.customName || incomingDevice.customName;
                const preservedGroup = deviceGroups.get(incomingDevice.serial) || oldDevice?.groupName || incomingDevice.groupName || '';

                // 更新设备信息，但保留服务端名称（别名优先）
                consoleClient.devices.set(incomingDevice.serial, {
                    ...incomingDevice,
                    customName: preservedName,
                    groupName: preservedGroup,
                    consoleId: consoleId,
                    videoWs: oldDevice?.videoWs || null,
                    controlWs: oldDevice?.controlWs || null, // 也保留控制连接
                    status: oldDevice?.status || 'ready',
                    viewerCount: oldDevice?.viewerCount || 0, // 保留观看者计数
                    lastActivityTime: oldDevice?.lastActivityTime || Date.now() // 保留最后活动时间
                });
                
                // 添加调试信息
                log('DEBUG', `[控制台] 设备 ${incomingDevice.serial} 缩略图数据长度: ${incomingDevice.thumbnail ? incomingDevice.thumbnail.length : 0}`);
            });
            
            log('INFO', `[控制台] ${consoleId} 更新了设备列表: ${msg.devices.length} 个设备`);
            broadcastDeviceListToWeb();
            break;
            
        case 'deviceUpdate':
            // 更新单个设备信息
            if (msg.device) {
                const incomingDevice = msg.device;
                const oldDevice = consoleClient.devices.get(incomingDevice.serial);
                const aliasName = deviceAliases.get(incomingDevice.serial);
                const preservedName = aliasName || oldDevice?.customName || incomingDevice.customName;
                const preservedGroup = deviceGroups.get(incomingDevice.serial) || oldDevice?.groupName || incomingDevice.groupName || '';

                // 更新设备信息，但不覆盖设备名称（别名优先）
                const mergedDevice = {
                    ...incomingDevice,
                    customName: preservedName,
                    groupName: preservedGroup,
                    consoleId: consoleId,
                    videoWs: oldDevice?.videoWs || null,
                    controlWs: oldDevice?.controlWs || null,
                    status: oldDevice?.status || 'ready',
                    viewerCount: oldDevice?.viewerCount || 0,
                    lastActivityTime: oldDevice?.lastActivityTime || Date.now()
                };
                consoleClient.devices.set(incomingDevice.serial, mergedDevice);
                
                log('INFO', `[控制台] ${consoleId} 更新了设备 ${incomingDevice.serial} 信息`);
                log('DEBUG', `[控制台] 设备 ${incomingDevice.serial} 缩略图数据长度: ${incomingDevice.thumbnail ? incomingDevice.thumbnail.length : 0}`);
                
                // 广播更新到所有Web客户端
                broadcastDeviceUpdateToWeb(mergedDevice);
            }
            break;
            
        case 'log':
            log('INFO', `[控制台日志] [${consoleId}] ${msg.message}`);
            break;
            
        case 'startStreaming':
            // 控制台已启动推流（携带实际生效的画质档位与参数）
            const streamDevice = consoleClient.devices.get(msg.serial);
            if (streamDevice) {
                streamDevice.status = 'streaming';
                streamDevice.streamingProfile = typeof msg.profile === 'string' ? msg.profile : undefined;
                streamDevice.streamingArgs = typeof msg.args === 'string' ? msg.args : undefined;
                streamDevice.keyframeMode = msg.keyframeMode === 'reset' ? 'reset' : 'sync';
                log('INFO', `[控制台] ${consoleId} 开始推流设备 ${msg.serial} (档位: ${streamDevice.streamingProfile || 'unknown'})`);

                // 通知正在观看该设备的 Web 客户端实际生效参数
                const targetDeviceId = `${consoleId}:${msg.serial}`;
                webClients.forEach((client) => {
                    if (client.currentDevice === targetDeviceId) {
                        sendWsJson(client.ws, {
                            type: 'streamingStarted',
                            deviceId: targetDeviceId,
                            serial: msg.serial,
                            profile: streamDevice.streamingProfile,
                            args: streamDevice.streamingArgs,
                            keyframeMode: streamDevice.keyframeMode
                        });
                    }
                });
            }
            break;
            
        case 'prepareStream':
            // 控制台预注册设备推流（新的处理方式）
            const prepareSerial = msg.serial;
            if (prepareSerial) {
                pendingDeviceStreams.set(prepareSerial, consoleId);
                log('INFO', `[控制台] ${consoleId} 预注册设备推流: ${prepareSerial}`);

                // 回复确认
                consoleClient.ws.send(JSON.stringify({
                    type: 'prepareStreamResponse',
                    serial: prepareSerial,
                    success: true
                }));
            }
            break;

        case 'startDeviceFailed':
            if (msg.serial) {
                log('WARN', `[控制台] ${consoleId} 启动设备失败: serial=${msg.serial}, reason=${msg.reason || 'unknown'}, message=${msg.message || ''}`);
                const targetDeviceId = `${consoleId}:${msg.serial}`;
                webClients.forEach((client) => {
                    if (client.currentDevice === targetDeviceId) {
                        sendWsJson(client.ws, {
                            type: 'startDeviceFailed',
                            deviceId: targetDeviceId,
                            serial: msg.serial,
                            reason: msg.reason || 'unknown',
                            message: msg.message || '控制台启动 scrcpy 失败'
                        });
                    }
                });
            }
            break;

        // ========== WebRTC 信令处理 ==========
        case 'webrtc-offer':
            // 控制台发送 WebRTC Offer
            if (WEBRTC_ENABLED) {
                WebRTC.handleOffer(consoleId, msg, consoleClient.ws, webClients);
            } else {
                log('WARN', '[WebRTC] WebRTC 未启用');
            }
            break;

        case 'webrtc-ice-candidate':
            // 控制台发送 ICE Candidate
            if (WEBRTC_ENABLED) {
                WebRTC.handleIceCandidate(consoleId, { ...msg, from: 'console' }, consoleClients, webClients);
            }
            break;

        case 'webrtc-connected':
            // 控制台 WebRTC 连接成功
            log('INFO', `[WebRTC] 控制台 ${consoleId} 设备 ${msg.deviceId} 连接成功`);
            break;

        case 'webrtc-disconnected':
            // 控制台 WebRTC 连接断开
            log('INFO', `[WebRTC] 控制台 ${consoleId} 设备 ${msg.deviceId} 连接断开`);
            WebRTC.cleanupConnection(msg.deviceId);
            break;

        case 'webrtc-error':
            // 控制台 WebRTC 错误
            log('ERROR', `[WebRTC] 控制台 ${consoleId} 设备 ${msg.deviceId} 错误: ${msg.error}`);
            break;

        default:
            log('WARN', `[控制台] 未知消息类型: ${msg.type}`);
            break;
    }
}

// Web 客户端控制命令频率限制（避免频繁按键引发控制台 ADB 进程泛洪）
const webControlLastTimes = new Map();
function isWebControlThrottled(clientId, minIntervalMs = 100) {
    const now = Date.now();
    const lastTime = webControlLastTimes.get(clientId) || 0;
    if (now - lastTime < minIntervalMs) {
        return true;
    }
    webControlLastTimes.set(clientId, now);
    return false;
}

// 处理 Web 客户端消息
function handleWebMessage(clientId, msg) {
    const webClient = webClients.get(clientId);
    if (!webClient) return;
    
    switch (msg.type) {
        case 'selectDevice':
            // 先从旧设备索引中移除
            if (webClient.currentDevice) {
                removeViewerFromIndex(webClient.currentDevice, webClient.ws);
            }

            log('INFO', `[Web客户端] ${clientId} 选择了设备 ${msg.deviceId}`);

            if (!msg.deviceId || typeof msg.deviceId !== 'string') {
                webClient.currentDevice = null;
                sendWsJson(webClient.ws, {
                    type: 'startDeviceFailed',
                    reason: 'invalid_device_id',
                    message: '设备ID无效'
                });
                break;
            }

            const [requestedConsoleId, requestedSerial] = splitDeviceId(msg.deviceId);
            log('DEBUG', `[Web客户端] 解析设备ID: consoleId=${requestedConsoleId}, serial=${requestedSerial}`);

            let consoleId = requestedConsoleId;
            let serial = requestedSerial;
            let consoleClient = consoleClients.get(consoleId);
            let device = consoleClient ? consoleClient.devices.get(serial) : null;

            // 优先检查用户指定的控制台设备是否存在且在线
            const requestedReady = !!(consoleClient &&
                device &&
                consoleClient.ws &&
                consoleClient.ws.readyState === WebSocket.OPEN);

            // 仅在指定控制台离线或未找到设备时，才尝试匹配其他控制台的同名设备
            if (!requestedReady) {
                const resolved = findDeviceBySerial(requestedSerial, requestedConsoleId);
                if (resolved.device && resolved.consoleId) {
                    consoleId = resolved.consoleId;
                    serial = resolved.serial || requestedSerial;
                    consoleClient = consoleClients.get(consoleId);
                    device = resolved.device;
                    log('INFO', `[Web客户端] 设备路由已重定向: ${requestedConsoleId}:${requestedSerial} -> ${consoleId}:${serial}`);
                }
            }

            if (!consoleClient) {
                webClient.currentDevice = null;
                log('WARN', `[Web客户端] 未找到控制台客户端: ${consoleId}`);
                log('DEBUG', `[Web客户端] 当前可用的控制台客户端:`, Array.from(consoleClients.keys()));
                sendWsJson(webClient.ws, {
                    type: 'startDeviceFailed',
                    deviceId: msg.deviceId,
                    serial,
                    reason: 'console_not_found',
                    message: '控制台不在线，请刷新后重试'
                });
                break;
            }

            if (!device) {
                webClient.currentDevice = null;
                log('WARN', `[Web客户端] 选择的设备不存在于控制台缓存: ${msg.deviceId}`);
                sendWsJson(webClient.ws, {
                    type: 'startDeviceFailed',
                    deviceId: msg.deviceId,
                    serial,
                    reason: 'device_not_found',
                    message: '设备不存在或已离线，请刷新设备列表'
                });
                break;
            }

            if (device.state && device.state !== 'device') {
                webClient.currentDevice = null;
                log('WARN', `[Web客户端] 设备状态不可启动: ${serial}, state=${device.state}`);
                sendWsJson(webClient.ws, {
                    type: 'startDeviceFailed',
                    deviceId: msg.deviceId,
                    serial,
                    reason: 'device_not_ready',
                    message: `设备当前状态为 ${device.state}，无法启动推流`
                });
                break;
            }

            // 验证通过后，才设置当前观看设备并加入索引
            const routedDeviceId = `${consoleId}:${serial}`;
            webClient.currentDevice = routedDeviceId;
            addViewerToIndex(routedDeviceId, webClient.ws);

            // 避免重复启动：设备已在推流时无需再次拉起 scrcpy
            if (device.videoWs && device.videoWs.readyState === WebSocket.OPEN) {
                log('INFO', `[Web客户端] 设备已在推流，跳过重复启动: ${serial}`);
                break;
            }

            if (consoleClient.ws.readyState === WebSocket.OPEN) {
                sendWsJson(consoleClient.ws, {
                    type: 'startDevice',
                    serial: serial,
                    // 画质档位（已在白名单内校验；未传或非法时由控制台回退默认档）
                    profile: normalizeVideoProfile(msg.profile)
                });
                log('INFO', `[Web客户端] 已发送startDevice消息到控制台: ${consoleId} (profile=${normalizeVideoProfile(msg.profile) || 'default'})`);
            } else {
                webClient.currentDevice = null;
                removeViewerFromIndex(routedDeviceId, webClient.ws);
                log('WARN', `[Web客户端] 控制台连接状态异常: ${consoleClient.ws.readyState}`);
                sendWsJson(webClient.ws, {
                    type: 'startDeviceFailed',
                    deviceId: routedDeviceId,
                    serial,
                    reason: 'console_ws_unavailable',
                    message: '控制台连接异常，无法下发启动指令'
                });
            }
            break;
            
        case 'touch':
            // 触摸事件，发送给 scrcpy 的控制 WebSocket
            if (webClient.currentDevice) {
                const [consoleId, serial] = splitDeviceId(webClient.currentDevice);
                
                // 查找 scrcpy 的控制 WebSocket 连接
                const consoleClient = consoleClients.get(consoleId);
                if (consoleClient) {
                    const device = consoleClient.devices.get(serial);
                    // 统一控制消息格式，便于 console 透传到本地 relay control 通道
                    const touchMsg = {
                        type: 'control',
                        serial,
                        action: 'touch',
                        touchType: msg.action,  // down/move/up
                        x: msg.x,
                        y: msg.y,
                        width: msg.width,
                        height: msg.height
                    };

                    if (device && device.controlWs && device.controlWs.readyState === WebSocket.OPEN) {
                        // 直连 scrcpy 控制通道
                        device.controlWs.send(JSON.stringify(touchMsg));
                        log('DEBUG', `[Web客户端] ${clientId} 直连发送触摸: ${msg.action} at (${msg.x}, ${msg.y})`);
                    } else if (consoleClient.ws && consoleClient.ws.readyState === WebSocket.OPEN) {
                        // 回退：通过 console ws 发送，再由 console 转发给本地 relay/scrcpy
                        sendWsJson(consoleClient.ws, touchMsg);
                        log('DEBUG', `[Web客户端] ${clientId} 经控制台转发触摸: ${msg.action} at (${msg.x}, ${msg.y})`);
                    } else {
                        log('WARN', `[Web客户端] ${clientId} 设备 ${serial} 控制连接不可用`);
                    }
                }
            }
            break;
            
        case 'control':
            // 控制按钮（Home/Back等）限流防爆
            if (isWebControlThrottled(clientId, 100)) {
                log('DEBUG', `[限流] 客户端 ${clientId} 控制指令过于密集，已丢弃`);
                break;
            }

            if (webClient.currentDevice) {
                const [consoleId, serial] = splitDeviceId(webClient.currentDevice);
                
                const consoleClient = consoleClients.get(consoleId);
                if (consoleClient) {
                    const device = consoleClient.devices.get(serial);
                    const controlMsg = {
                        type: 'control',
                        serial,
                        action: msg.action
                    };

                    if (device && device.controlWs && device.controlWs.readyState === WebSocket.OPEN) {
                        // 直连 scrcpy 控制通道
                        device.controlWs.send(JSON.stringify(controlMsg));
                        log('INFO', `[Web客户端] ${clientId} 直连发送控制: ${msg.action}`);
                    } else if (consoleClient.ws && consoleClient.ws.readyState === WebSocket.OPEN) {
                        // 回退：通过 console ws
                        sendWsJson(consoleClient.ws, controlMsg);
                        log('INFO', `[Web客户端] ${clientId} 经控制台转发控制: ${msg.action}`);
                    }
                }
            }
            break;
            
        case 'stopDevice':
            // 停止设备推流
            if (webClient.currentDevice) {
                const currentDeviceId = webClient.currentDevice;
                const [consoleId, serial] = splitDeviceId(currentDeviceId);
                
                log('INFO', `[Web客户端] ${clientId} 请求停止设备: ${currentDeviceId}`);
                
                // 从观看者索引中移除当前客户端
                removeViewerFromIndex(currentDeviceId, webClient.ws);
                webClient.currentDevice = null;
                
                const consoleClient = consoleClients.get(consoleId);
                if (consoleClient) {
                    // 更新观看者计数
                    const device = consoleClient.devices.get(serial);
                    if (device && device.viewerCount > 0) {
                        device.viewerCount--;
                    }
                    
                    // 核心修复：检查当前设备是否还有其他在线观看者
                    const viewers = deviceViewerIndex.get(currentDeviceId);
                    const activeViewers = viewers ? viewers.size : 0;
                    
                    if (activeViewers === 0 && (!device || device.viewerCount <= 0)) {
                        if (device) device.viewerCount = 0;
                        if (consoleClient.ws && consoleClient.ws.readyState === WebSocket.OPEN) {
                            consoleClient.ws.send(JSON.stringify({
                                type: 'stopDevice',
                                serial: serial
                            }));
                            log('INFO', `[Web客户端] 设备 ${currentDeviceId} 已无任何观看者，已下发停止请求到控制台: ${consoleId}`);
                        }
                    } else {
                        log('INFO', `[Web客户端] 设备 ${currentDeviceId} 仍有 ${activeViewers} 位观看者，保持推流`);
                    }
                }
            }
            break;
            
        case 'updateDeviceName':
            // 更新设备名称（RBAC: 仅管理员可操作）
            if (msg.deviceId && msg.customName) {
                if (webClient.user && webClient.user.role && webClient.user.role !== 'admin') {
                    sendWsJson(webClient.ws, {
                        type: 'error',
                        message: '权限不足：仅管理员可以修改设备名称'
                    });
                    break;
                }
                const [consoleId, serial] = splitDeviceId(msg.deviceId);
                
                log('INFO', `[Web客户端] ${clientId} 请求更新设备名称: ${msg.deviceId} -> ${msg.customName}`);
                
                // 保存全局设备别名（同时支持 deviceId 与 serial 索引）
                deviceAliases.set(msg.deviceId, msg.customName);
                deviceAliases.set(serial, msg.customName);
                saveDeviceAliases();
                
                // 更新内存中的设备信息
                const consoleClient = consoleClients.get(consoleId);
                if (consoleClient) {
                    const device = consoleClient.devices.get(serial);
                    if (device) {
                        device.customName = msg.customName;
                    }
                }
                
                // 广播更新后的设备列表
                broadcastDeviceListToWeb();
            }
            break;

        case 'updateDeviceGroup':
            // 更新设备分组（RBAC: 仅管理员可操作）
            if (msg.deviceId && typeof msg.groupName === 'string') {
                if (webClient.user && webClient.user.role && webClient.user.role !== 'admin') {
                    sendWsJson(webClient.ws, {
                        type: 'error',
                        message: '权限不足：仅管理员可以修改设备分组'
                    });
                    break;
                }
                const [consoleId, serial] = splitDeviceId(msg.deviceId);
                const normalizedGroupName = msg.groupName.trim().slice(0, 40);

                if (normalizedGroupName) {
                    deviceGroups.set(msg.deviceId, normalizedGroupName);
                    deviceGroups.set(serial, normalizedGroupName);
                    log('INFO', `[Web客户端] ${clientId} 更新设备分组: ${msg.deviceId} -> ${normalizedGroupName}`);
                } else {
                    deviceGroups.delete(msg.deviceId);
                    deviceGroups.delete(serial);
                    log('INFO', `[Web客户端] ${clientId} 清除设备分组: ${msg.deviceId}`);
                }
                saveDeviceGroups();

                const consoleClient = consoleClients.get(consoleId);
                if (consoleClient) {
                    const device = consoleClient.devices.get(serial);
                    if (device) {
                        device.groupName = normalizedGroupName;
                    }
                }

                broadcastDeviceListToWeb();
            }
            break;

        // ========== WebRTC 信令处理 ==========
        case 'webrtc-answer':
            // Web 客户端发送 WebRTC Answer
            if (WEBRTC_ENABLED) {
                WebRTC.handleAnswer(clientId, msg, consoleClients);
            }
            break;

        case 'webrtc-ice-candidate':
            // Web 客户端发送 ICE Candidate
            if (WEBRTC_ENABLED) {
                WebRTC.handleIceCandidate(clientId, { ...msg, from: 'web' }, consoleClients, webClients);
            }
            break;

        case 'webrtc-connected':
            // Web 客户端 WebRTC 连接成功
            log('INFO', `[WebRTC] Web客户端 ${clientId} 设备 ${msg.deviceId} 连接成功`);
            break;

        case 'webrtc-disconnected':
            // Web 客户端 WebRTC 连接断开
            log('INFO', `[WebRTC] Web客户端 ${clientId} 设备 ${msg.deviceId} 连接断开`);
            break;

        case 'webrtc-error':
            // Web 客户端 WebRTC 错误
            log('ERROR', `[WebRTC] Web客户端 ${clientId} 设备 ${msg.deviceId} 错误: ${msg.error}`);
            break;
    }
}

// 设备观看者索引：deviceKey -> Set<WebSocket>
// 用于视频转发时 O(1) 查找观看者，避免遍历所有 Web 客户端
const deviceViewerIndex = new Map();

function addViewerToIndex(deviceId, ws) {
    if (!deviceViewerIndex.has(deviceId)) {
        deviceViewerIndex.set(deviceId, new Set());
    }
    deviceViewerIndex.get(deviceId).add(ws);
}

function removeViewerFromIndex(deviceId, ws) {
    const viewers = deviceViewerIndex.get(deviceId);
    if (viewers) {
        viewers.delete(ws);
        if (viewers.size === 0) {
            deviceViewerIndex.delete(deviceId);
        }
    }
}

// 向单个 Web 客户端发送设备列表
function sendDeviceListToWeb(ws) {
    const allDevices = buildWebDeviceList();

    log('DEBUG', `[WS] 发送设备列表到Web客户端，设备数量: ${allDevices.length}`);
    ws.send(JSON.stringify({
        type: 'deviceList',
        devices: allDevices
    }));
}

// 广播设备列表到所有 Web 客户端（带 dirty 标记，避免重复广播）
let _broadcastDirty = false;
let _broadcastTimer = null;

function broadcastDeviceListToWeb() {
    _broadcastDirty = true;
    // 合并短时间内的多次广播为一次（100ms debounce）
    if (!_broadcastTimer) {
        _broadcastTimer = setTimeout(() => {
            _broadcastTimer = null;
            if (!_broadcastDirty) return;
            _broadcastDirty = false;
            
            const allDevices = buildWebDeviceList();
            
            const message = JSON.stringify({
                type: 'deviceList',
                devices: allDevices
            });
            
            webClients.forEach((client) => {
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(message);
                }
            });
            
            log('DEBUG', `[设备列表] 已广播到 ${webClients.size} 个 Web 客户端`);
        }, 100);
    }
}

// 广播单个设备更新到所有 Web 客户端
function broadcastDeviceUpdateToWeb(device) {
    const safeDevice = {
        id: device.id || `${device.consoleId}:${device.serial}`,
        serial: device.serial,
        model: device.model,
        state: device.state,
        status: device.status,
        consoleId: device.consoleId,
        customName: device.customName,
        groupName: device.groupName,
        thumbnail: device.thumbnail
    };
    const message = JSON.stringify({
        type: 'deviceUpdate',
        device: safeDevice
    });
    webClients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
        }
    });
}

// 定期广播设备列表（每分钟一次，仅当有变更时）
setInterval(() => {
    if (webClients.size > 0) {
        broadcastDeviceListToWeb();
    }
}, 60000); // 60秒

// 启动 HTTP 服务器
httpServer.listen(HTTP_PORT, async () => {
    log('INFO', '========================================');
    log('INFO', '  Scrcpy 中继服务器已启动');
    log('INFO', '========================================');
    log('INFO', `  HTTP 端口: ${HTTP_PORT}`);
    log('INFO', `  Web界面: http://localhost:${HTTP_PORT}`);
    log('INFO', `  scrcpy 连接: ws://localhost:${HTTP_PORT}`);

    if (ENABLE_HTTPS) {
        log('INFO', '');
        log('INFO', `  HTTPS 端口: ${HTTPS_PORT}`);
        log('INFO', `  安全访问: https://localhost:${HTTPS_PORT}`);
        log('INFO', `  远程访问: wss://your-domain:${HTTPS_PORT}`);
    }

    // 初始化 TURN 服务器
    if (TURN_ENABLED) {
        const turnStarted = await TurnServer.initTurnServer();
        if (turnStarted) {
            log('INFO', `  TURN 端口: ${TURN_PORT}`);
        }
    }

    log('INFO', '========================================');
    log('INFO', '');
    log('INFO', '使用说明：');
    log('INFO', `  - scrcpy 使用 HTTP 端口 ${HTTP_PORT} （无需 SSL）`);
    if (ENABLE_HTTPS) {
        log('INFO', `  - Web 浏览器可使用 HTTPS 端口 ${HTTPS_PORT}`);
    }
    log('INFO', '========================================');
});

// 如果启用了 HTTPS，启动 HTTPS 服务器
if (ENABLE_HTTPS && httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
        log('INFO', `[HTTPS] 服务器已在端口 ${HTTPS_PORT} 启动`);
    });
}

// 定期检查空闲设备并自动关闭
setInterval(() => {
    const now = Date.now();
    
    consoleClients.forEach((consoleClient, consoleId) => {
        consoleClient.devices.forEach((device, serial) => {
            // 只检查正在推流的设备
            if (device.status === 'streaming' && device.videoWs) {
                const viewerCount = device.viewerCount || 0;
                const lastActivityTime = device.lastActivityTime || 0;
                const idleTime = now - lastActivityTime;
                
                // 如果没有观看者且空闲超过设定时间，关闭推流
                if (viewerCount === 0 && idleTime > IDLE_TIMEOUT) {
                    log('INFO', `[空闲检测] 设备 ${serial} 已空闲 ${Math.floor(idleTime / 1000)}秒，自动关闭推流`);
                    
                    // 通知控制台停止该设备
                    if (consoleClient.ws.readyState === WebSocket.OPEN) {
                        consoleClient.ws.send(JSON.stringify({
                            type: 'stopDevice',
                            serial: serial,
                            reason: 'idle_timeout'
                        }));
                    }
                }
            }
        });
    });
}, 60000); // 每分钟检查一次

// WebSocket 应用层心跳保活检测（每 30 秒主动发送 Ping 帧）
const heartbeatInterval = setInterval(() => {
    // 检查控制台连接活性
    consoleClients.forEach((client, id) => {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.ping();
            } catch (e) {
                log('WARN', `[心跳] 控制台 ${id} Ping 发送失败:`, e.message);
            }
        }
    });

    // 检查 Web 客户端活性
    webClients.forEach((client, id) => {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.ping();
            } catch (e) {
                log('WARN', `[心跳] Web客户端 ${id} Ping 发送失败:`, e.message);
            }
        }
    });
}, 30000);

// Graceful shutdown：优雅关闭服务器
function gracefulShutdown(signal) {
    log('INFO', `[关闭] 收到 ${signal} 信号，正在优雅关闭...`);

    // 停止心跳检测
    clearInterval(heartbeatInterval);

    // 停止 TURN 服务器
    TurnServer.stopTurnServer();

    // 通知所有控制台客户端
    consoleClients.forEach((client, id) => {
        try {
            client.ws.close(1001, '服务器关闭');
        } catch (e) { /* ignore */ }
    });
    
    // 通知所有 Web 客户端
    webClients.forEach((client, id) => {
        try {
            client.ws.close(1001, '服务器关闭');
        } catch (e) { /* ignore */ }
    });
    
    // 关闭 HTTP 服务器
    httpServer.close(() => {
        log('INFO', '[关闭] HTTP 服务器已关闭');
    });
    
    // 关闭 HTTPS 服务器
    if (httpsServer) {
        httpsServer.close(() => {
            log('INFO', '[关闭] HTTPS 服务器已关闭');
        });
    }
    
    // 5秒后强制退出
    setTimeout(() => {
        log('WARN', '[关闭] 强制退出');
        process.exit(0);
    }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
