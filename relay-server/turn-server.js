/**
 * TURN 服务器模块
 * 使用 node-turn 提供 TURN 服务
 *
 * 安装: npm install node-turn
 *
 * 环境变量配置:
 *   TURN_ENABLED=true          - 启用 TURN 服务器
 *   TURN_PORT=3478             - TURN 端口
 *   TURN_SECRET=your-secret    - 长期凭证密钥
 *   TURN_RANGE_MIN=49152       - 中继端口范围最小值
 *   TURN_RANGE_MAX=65535       - 中继端口范围最大值
 */

let turnServer = null;
let turnConfig = null;

/**
 * 初始化 TURN 服务器
 * @param {Object} options - 配置选项
 * @returns {Promise<boolean>} 是否成功
 */
async function initTurnServer(options = {}) {
    const {
        enabled = process.env.TURN_ENABLED === 'true',
        port = parseInt(process.env.TURN_PORT) || 3478,
        secret = process.env.TURN_SECRET || generateRandomSecret(),
        realm = process.env.TURN_REALM || 'scrcpy.local',
        minPort = parseInt(process.env.TURN_RANGE_MIN) || 49152,
        maxPort = parseInt(process.env.TURN_RANGE_MAX) || 65535
    } = options;

    if (!enabled) {
        console.log('[TURN] TURN 服务器未启用');
        return false;
    }

    try {
        // 动态加载 node-turn
        const turn = require('node-turn');

        // 生成初始凭据并支持动态时间戳凭证验证
        const baseCredentials = {};
        const username = generateTimestampUsername();
        const credential = generateCredential(username, secret);

        baseCredentials[username] = credential;

        const credentialsProxy = new Proxy(baseCredentials, {
            get(target, prop) {
                if (typeof prop !== 'string') return target[prop];
                if (target[prop]) return target[prop];
                const parts = prop.split(':');
                const ts = parseInt(parts[0], 10);
                if (!isNaN(ts)) {
                    const now = Math.floor(Date.now() / 1000);
                    if (ts >= now) {
                        return generateCredential(prop, secret);
                    }
                }
                return undefined;
            },
            has(target, prop) {
                if (typeof prop !== 'string') return prop in target;
                if (prop in target) return true;
                const parts = prop.split(':');
                const ts = parseInt(parts[0], 10);
                if (!isNaN(ts)) {
                    const now = Math.floor(Date.now() / 1000);
                    return ts >= now;
                }
                return false;
            }
        });

        turnServer = new turn({
            authMech: 'long-term',
            credentials: credentialsProxy,
            realm: realm,
            minPort: minPort,
            maxPort: maxPort,
            listeningPort: port,
            debugLevel: process.env.LOG_LEVEL === 'DEBUG' ? 'ALL' : 'WARN'
        });

        turnServer.start();

        turnConfig = {
            url: `turn:${getServerPublicIp()}:${port}`,
            username,
            credential,
            secret,
            realm,
            port
        };

        console.log(`[TURN] TURN 服务器已启动，端口: ${port}`);
        console.log(`[TURN] Realm: ${realm}`);

        return true;
    } catch (error) {
        console.error('[TURN] 启动 TURN 服务器失败:', error.message);
        console.log('[TURN] 提示: 请运行 npm install node-turn 安装依赖');
        return false;
    }
}

/**
 * 停止 TURN 服务器
 */
function stopTurnServer() {
    if (turnServer) {
        turnServer.stop();
        turnServer = null;
        // 同步清空配置，避免停止后 getTurnConfig 仍向 Web 端发放失效凭证
        turnConfig = null;
        console.log('[TURN] TURN 服务器已停止');
    }
}

/**
 * 获取 TURN 配置（用于 WebRTC）
 * @param {number} ttl - 凭证有效期（秒）
 * @returns {Object|null} TURN 配置
 */
function getTurnConfig(ttl = 86400) {
    if (!turnConfig) {
        return null;
    }

    // 生成新的时间戳凭证
    const username = generateTimestampUsername(ttl);
    const credential = generateCredential(username, turnConfig.secret);

    return {
        url: turnConfig.url,
        username,
        credential
    };
}

/**
 * 生成随机密钥
 * @returns {string} 随机密钥
 */
function generateRandomSecret() {
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 生成时间戳用户名
 * @param {number} ttl - 有效期（秒）
 * @returns {string} 时间戳用户名
 */
function generateTimestampUsername(ttl = 86400) {
    const timestamp = Math.floor(Date.now() / 1000) + ttl;
    return timestamp.toString();
}

/**
 * 生成凭证
 * @param {string} username - 用户名（时间戳）
 * @param {string} secret - 密钥
 * @returns {string} 凭证
 */
function generateCredential(username, secret) {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(username);
    return hmac.digest('base64');
}

/**
 * 获取服务器公网 IP
 * @returns {string} 公网 IP 或 'localhost'
 */
function getServerPublicIp() {
    // 优先使用环境变量
    if (process.env.PUBLIC_IP) {
        return process.env.PUBLIC_IP;
    }

    // 尝试从网络接口获取
    const os = require('os');
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // 跳过内部和非 IPv4 地址
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }

    return 'localhost';
}

/**
 * 检查 TURN 服务器是否运行
 * @returns {boolean}
 */
function isTurnRunning() {
    return turnServer !== null;
}

module.exports = {
    initTurnServer,
    stopTurnServer,
    getTurnConfig,
    generateTimestampUsername,
    generateCredential,
    isTurnRunning
};