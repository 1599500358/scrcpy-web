/**
 * WebRTC 信令处理模块
 * 处理 SDP 交换和 ICE candidate 转发
 */

// 存储待处理的 WebRTC 连接请求
// deviceId -> { offer, candidates, consoleWs, webWs }
const pendingConnections = new Map();

// WebRTC 配置
const defaultIceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

/**
 * 获取 WebRTC 配置
 * @param {Object} turnConfig - TURN 服务器配置 { url, username, credential }
 * @returns {Object} RTCConfiguration
 */
function getRTCConfiguration(turnConfig = null) {
    const config = {
        iceServers: [...defaultIceServers]
    };

    if (turnConfig && turnConfig.url) {
        config.iceServers.push({
            urls: turnConfig.url,
            username: turnConfig.username,
            credential: turnConfig.credential
        });
    }

    return config;
}

/**
 * 处理来自控制台的 WebRTC Offer
 * @param {string} consoleId - 控制台客户端 ID
 * @param {Object} msg - 消息对象 { type, deviceId, sdp }
 * @param {WebSocket} consoleWs - 控制台 WebSocket 连接
 * @param {Map} webClients - Web 客户端映射
 */
function handleOffer(consoleId, msg, consoleWs, webClients) {
    const { deviceId, sdp } = msg;

    if (!deviceId || !sdp) {
        console.log('[WebRTC] 无效的 offer 消息：缺少 deviceId 或 sdp');
        return;
    }

    // 校验设备所有权：Offer 必须由所属控制台发起
    if (!deviceId.startsWith(`${consoleId}:`)) {
        console.log(`[WebRTC] 拦截非法 Offer：控制台 ${consoleId} 不拥有设备 ${deviceId}`);
        return;
    }

    console.log(`[WebRTC] ========== 收到 Offer ==========`);
    console.log(`[WebRTC] 控制台: ${consoleId}`);
    console.log(`[WebRTC] 设备: ${deviceId}`);
    console.log(`[WebRTC] SDP 类型: ${sdp.type}`);

    // 查找所有正在观看该设备的 Web 客户端
    const targetWebClients = [];
    const allowedViewers = new Set();
    console.log(`[WebRTC] 查找 Web 客户端，当前 webClients 数量: ${webClients ? webClients.size : 0}`);

    if (webClients) {
        webClients.forEach((client, clientId) => {
            if (client.currentDevice === deviceId && client.ws && client.ws.readyState === 1) {
                targetWebClients.push({ ws: client.ws, clientId });
                allowedViewers.add(clientId);
            }
        });
    }

    // 存储连接信息与授权观看者列表
    pendingConnections.set(deviceId, {
        consoleId,
        consoleWs,
        offer: sdp,
        candidates: [],
        webWs: targetWebClients.length > 0 ? targetWebClients[0].ws : null,
        targetWebClients,
        allowedViewers,
        answer: null
    });

    if (targetWebClients.length > 0) {
        const offerMsg = JSON.stringify({
            type: 'webrtc-offer',
            deviceId,
            sdp,
            consoleId
        });

        targetWebClients.forEach(({ ws: clientWs, clientId }) => {
            clientWs.send(offerMsg);
            console.log(`[WebRTC] ✅ Offer 已转发给 Web 客户端 ${clientId}`);
        });
        console.log(`[WebRTC] ================================`);
    } else {
        console.log(`[WebRTC] ❌ 未找到观看设备 ${deviceId} 的 Web 客户端`);
        console.log(`[WebRTC] ================================`);

        // 通知控制台等待 Web 客户端
        if (consoleWs && consoleWs.readyState === 1) {
            consoleWs.send(JSON.stringify({
                type: 'webrtc-waiting',
                deviceId,
                message: '等待 Web 客户端连接'
            }));
        }
    }
}

/**
 * 处理来自 Web 客户端的 WebRTC Answer
 * @param {string} webClientId - Web 客户端 ID
 * @param {Object} msg - 消息对象 { type, deviceId, sdp }
 * @param {Map} consoleClients - 控制台客户端映射
 * @param {Map} [webClients] - 可选的 Web 客户端映射
 */
function handleAnswer(webClientId, msg, consoleClients, webClients) {
    const { deviceId, sdp } = msg;

    if (!deviceId || !sdp) {
        console.log('[WebRTC] 无效的 answer 消息：缺少 deviceId 或 sdp');
        return;
    }

    console.log(`[WebRTC] 收到 Web 客户端 ${webClientId} 的 answer，设备: ${deviceId}`);

    // 校验参与者：Web 客户端必须在允许的观看者集合中，或其 currentDevice 确为该 deviceId
    const conn = pendingConnections.get(deviceId);
    if (!conn) {
        console.log(`[WebRTC] 未找到设备 ${deviceId} 的待处理连接`);
        return;
    }

    if (webClients && webClients.has(webClientId)) {
        const client = webClients.get(webClientId);
        if (!client || client.currentDevice !== deviceId) {
            console.log(`[WebRTC] 拦截未授权 Answer：客户端 ${webClientId} 未选择设备 ${deviceId}`);
            return;
        }
    } else if (conn.allowedViewers && conn.allowedViewers.size > 0 && !conn.allowedViewers.has(webClientId)) {
        console.log(`[WebRTC] 拦截未授权 Answer：客户端 ${webClientId} 不在允许的观看者列表中`);
        return;
    }

    // 存储 answer
    conn.answer = sdp;

    // 解析 deviceId 获取 consoleId（格式：consoleId:serial）
    const [consoleId] = deviceId.split(':');
    const consoleClient = consoleClients.get(consoleId);

    if (consoleClient && consoleClient.ws.readyState === 1) {
        // 转发 answer 给控制台
        consoleClient.ws.send(JSON.stringify({
            type: 'webrtc-answer',
            deviceId,
            sdp
        }));

        console.log(`[WebRTC] Answer 已转发给控制台 ${consoleId}`);

        // 发送缓存的 ICE candidates
        if (conn.candidates.length > 0) {
            console.log(`[WebRTC] 发送 ${conn.candidates.length} 个缓存的 ICE candidates 给控制台`);
            conn.candidates.forEach(candidate => {
                consoleClient.ws.send(JSON.stringify({
                    type: 'webrtc-ice-candidate',
                    deviceId,
                    candidate
                }));
            });
        }
    } else {
        console.log(`[WebRTC] 控制台 ${consoleId} 不在线或连接已断开`);
    }
}

/**
 * 处理 ICE Candidate
 * @param {string} fromId - 发送者 ID
 * @param {Object} msg - 消息对象 { type, deviceId, candidate, from }
 * @param {Map} consoleClients - 控制台客户端映射
 * @param {Map} webClients - Web 客户端映射
 */
function handleIceCandidate(fromId, msg, consoleClients, webClients) {
    const { deviceId, candidate, from } = msg;

    if (!deviceId || !candidate) {
        console.log('[WebRTC] 无效的 ice-candidate 消息：缺少 deviceId 或 candidate');
        return;
    }

    console.log(`[WebRTC] 收到来自 ${from} 的 ICE candidate，设备: ${deviceId}`);

    const conn = pendingConnections.get(deviceId);

    if (from === 'console') {
        // 校验来自控制台的 candidate 必须与设备所属控制台严格一致
        if (!deviceId.startsWith(`${fromId}:`)) {
            console.log(`[WebRTC] 拦截非法 ICE candidate：控制台 ${fromId} 不拥有设备 ${deviceId}`);
            return;
        }

        // 来自控制台，转发给该设备的所有合法 Web 观看者
        let sent = false;
        if (webClients) {
            webClients.forEach((client) => {
                if (client.currentDevice === deviceId && client.ws && client.ws.readyState === 1) {
                    client.ws.send(JSON.stringify({
                        type: 'webrtc-ice-candidate',
                        deviceId,
                        candidate
                    }));
                    sent = true;
                }
            });
        }
        if (!sent && conn) {
            conn.candidates.push(candidate);
            console.log(`[WebRTC] Web 客户端未连接，缓存 ICE candidate (共 ${conn.candidates.length} 个)`);
        }
    } else if (from === 'web') {
        // 校验来自 Web 端的 candidate，发送者必须当前正选看该设备
        if (webClients && webClients.has(fromId)) {
            const client = webClients.get(fromId);
            if (!client || client.currentDevice !== deviceId) {
                console.log(`[WebRTC] 拦截非法 ICE candidate：Web 客户端 ${fromId} 未选看设备 ${deviceId}`);
                return;
            }
        }

        // 转发给控制台
        const [consoleId] = deviceId.split(':');
        const consoleClient = consoleClients ? consoleClients.get(consoleId) : null;

        if (consoleClient && consoleClient.ws && consoleClient.ws.readyState === 1) {
            consoleClient.ws.send(JSON.stringify({
                type: 'webrtc-ice-candidate',
                deviceId,
                candidate
            }));
        } else {
            console.log(`[WebRTC] 控制台 ${consoleId} 不在线，无法转发 ICE candidate`);
        }
    }
}

/**
 * 处理 Web 客户端选择设备（触发 WebRTC 连接）
 * @param {string} webClientId - Web 客户端 ID
 * @param {string} deviceId - 设备 ID
 * @param {WebSocket} webWs - Web 客户端 WebSocket
 * @param {Map} consoleClients - 控制台客户端映射
 */
function handleWebSelectDevice(webClientId, deviceId, webWs, consoleClients) {
    const conn = pendingConnections.get(deviceId);

    if (conn && conn.offer) {
        // 已有缓存的 offer，直接发送给 Web 客户端
        webWs.send(JSON.stringify({
            type: 'webrtc-offer',
            deviceId,
            sdp: conn.offer,
            consoleId: conn.consoleId
        }));

        // 更新 webWs
        conn.webWs = webWs;

        console.log(`[WebRTC] 发送缓存的 offer 给新连接的 Web 客户端 ${webClientId}`);
    }
}

/**
 * 清理设备的 WebRTC 连接信息
 * @param {string} deviceId - 设备 ID
 */
function cleanupConnection(deviceId) {
    if (pendingConnections.has(deviceId)) {
        pendingConnections.delete(deviceId);
        console.log(`[WebRTC] 清理设备 ${deviceId} 的连接信息`);
    }
}

/**
 * 获取 TURN 服务器配置
 * @param {Object} options - 配置选项
 * @returns {Object|null} TURN 配置
 */
function getTurnConfig(options = {}) {
    const {
        host = process.env.TURN_HOST || 'localhost',
        port = process.env.TURN_PORT || 3478,
        username = process.env.TURN_USERNAME,
        credential = process.env.TURN_CREDENTIAL
    } = options;

    if (!username || !credential) {
        return null;
    }

    return {
        url: `turn:${host}:${port}`,
        username,
        credential
    };
}

/**
 * 生成临时 TURN 凭证（用于短期凭证认证）
 * @param {string} secret - TURN 服务器密钥
 * @param {number} ttl - 有效期（秒）
 * @returns {Object} { username, credential, timestamp }
 */
function generateTurnCredentials(secret, ttl = 86400) {
    const timestamp = Math.floor(Date.now() / 1000) + ttl;
    const username = timestamp.toString();

    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(username);
    const credential = hmac.digest('base64');

    return { username, credential, timestamp };
}

module.exports = {
    getRTCConfiguration,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    handleWebSelectDevice,
    cleanupConnection,
    getTurnConfig,
    generateTurnCredentials,
    pendingConnections
};