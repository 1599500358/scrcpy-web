'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const WebRTC = require('../../webrtc-signaling');

// 模拟 WebSocket：readyState=1 (OPEN)，记录所有 send 的 JSON 消息
function makeWs(readyState = 1) {
    return {
        readyState,
        sent: [],
        send(data) { this.sent.push(JSON.parse(data)); }
    };
}

// 构造 webClients 映射条目
function makeWebClient(deviceId, ws) {
    return { currentDevice: deviceId, ws };
}

beforeEach(() => {
    // pendingConnections 是模块级共享状态，逐条清空避免用例间串扰
    for (const key of [...WebRTC.pendingConnections.keys()]) {
        WebRTC.pendingConnections.delete(key);
    }
});

describe('getRTCConfiguration', () => {
    test('默认只含两个 Google STUN 服务器', () => {
        const config = WebRTC.getRTCConfiguration();
        assert.deepStrictEqual(config, {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });
    });

    test('传入 TURN 配置时追加 TURN 服务器', () => {
        const config = WebRTC.getRTCConfiguration({
            url: 'turn:1.2.3.4:3478', username: 'u', credential: 'p'
        });
        assert.strictEqual(config.iceServers.length, 3);
        assert.deepStrictEqual(config.iceServers[2], {
            urls: 'turn:1.2.3.4:3478', username: 'u', credential: 'p'
        });
    });

    test('TURN 配置缺少 url 时不追加', () => {
        const config = WebRTC.getRTCConfiguration({ username: 'u', credential: 'p' });
        assert.strictEqual(config.iceServers.length, 2);
    });

    test('每次调用返回独立副本，修改不影响默认配置', () => {
        const a = WebRTC.getRTCConfiguration();
        a.iceServers.push({ urls: 'stun:extra' });
        assert.strictEqual(WebRTC.getRTCConfiguration().iceServers.length, 2);
    });
});

describe('handleOffer', () => {
    test('缺少 deviceId 或 sdp 时直接忽略', () => {
        const consoleWs = makeWs();
        WebRTC.handleOffer('c1', { type: 'offer', deviceId: '', sdp: { type: 'offer' } }, consoleWs, new Map());
        WebRTC.handleOffer('c1', { type: 'offer', deviceId: 'c1:d1', sdp: null }, consoleWs, new Map());
        assert.strictEqual(WebRTC.pendingConnections.size, 0);
        assert.strictEqual(consoleWs.sent.length, 0);
    });

    test('拦截不属于该控制台的设备 Offer', () => {
        const consoleWs = makeWs();
        const webWs = makeWs();
        const webClients = new Map([['w1', makeWebClient('c2:d1', webWs)]]);
        WebRTC.handleOffer('c1', { deviceId: 'c2:d1', sdp: { type: 'offer', sdp: 'v=0' } }, consoleWs, webClients);
        assert.strictEqual(WebRTC.pendingConnections.size, 0);
        assert.strictEqual(webWs.sent.length, 0);
        assert.strictEqual(consoleWs.sent.length, 0);
    });

    test('转发 Offer 给正在观看该设备的 Web 客户端并记录授权观看者', () => {
        const consoleWs = makeWs();
        const webWs = makeWs();
        const sdp = { type: 'offer', sdp: 'v=0' };
        const webClients = new Map([['w1', makeWebClient('c1:d1', webWs)]]);
        WebRTC.handleOffer('c1', { deviceId: 'c1:d1', sdp }, consoleWs, webClients);

        assert.strictEqual(webWs.sent.length, 1);
        assert.deepStrictEqual(webWs.sent[0], { type: 'webrtc-offer', deviceId: 'c1:d1', sdp, consoleId: 'c1' });

        const conn = WebRTC.pendingConnections.get('c1:d1');
        assert.ok(conn, '应记录待处理连接');
        assert.deepStrictEqual(conn.allowedViewers, new Set(['w1']));
        assert.strictEqual(conn.consoleWs, consoleWs);
        assert.deepStrictEqual(conn.candidates, []);
    });

    test('未选看该设备的 Web 客户端不会收到 Offer', () => {
        const consoleWs = makeWs();
        const watcherWs = makeWs();
        const otherWs = makeWs();
        const webClients = new Map([
            ['w1', makeWebClient('c1:d1', watcherWs)],
            ['w2', makeWebClient('c1:other', otherWs)]
        ]);
        WebRTC.handleOffer('c1', { deviceId: 'c1:d1', sdp: { type: 'offer' } }, consoleWs, webClients);
        assert.strictEqual(otherWs.sent.length, 0);
        assert.strictEqual(watcherWs.sent.length, 1);
    });

    test('没有观看者时通知控制台等待', () => {
        const consoleWs = makeWs();
        WebRTC.handleOffer('c1', { deviceId: 'c1:d1', sdp: { type: 'offer' } }, consoleWs, new Map());
        assert.deepStrictEqual(consoleWs.sent[0], {
            type: 'webrtc-waiting', deviceId: 'c1:d1', message: '等待 Web 客户端连接'
        });
        // 仍然缓存 offer 供后续 Web 客户端选择设备时使用
        assert.strictEqual(WebRTC.pendingConnections.get('c1:d1').offer.type, 'offer');
    });

    test('控制台连接非 OPEN 状态时不发送等待消息', () => {
        const consoleWs = makeWs(3); // CLOSED
        WebRTC.handleOffer('c1', { deviceId: 'c1:d1', sdp: { type: 'offer' } }, consoleWs, new Map());
        assert.strictEqual(consoleWs.sent.length, 0);
    });
});

describe('handleAnswer', () => {
    test('缺少参数或无待处理连接时忽略', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        WebRTC.handleAnswer('w1', { deviceId: '', sdp: {} }, consoleClients, new Map());
        WebRTC.handleAnswer('w1', { deviceId: 'c1:d1', sdp: { type: 'answer' } }, consoleClients, new Map());
        assert.strictEqual(consoleWs.sent.length, 0);
    });

    test('未选看该设备的 Web 客户端发送 Answer 被拦截', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        const webClients = new Map([['w1', makeWebClient('c1:other', makeWs())]]);
        WebRTC.handleAnswer('w1', { deviceId: 'c1:d1', sdp: { type: 'answer' } }, consoleClients, webClients);
        assert.strictEqual(consoleWs.sent.length, 0);
    });

    test('不在授权观看者列表中的客户端被拦截', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        // 预置连接，allowedViewers 只含 w1
        WebRTC.pendingConnections.set('c1:d1', {
            consoleId: 'c1', consoleWs, offer: {}, candidates: [], allowedViewers: new Set(['w1']), answer: null
        });
        // 传入空 webClients 使校验走 allowedViewers 分支
        WebRTC.handleAnswer('w2', { deviceId: 'c1:d1', sdp: { type: 'answer' } }, consoleClients, new Map());
        assert.strictEqual(consoleWs.sent.length, 0);
    });

    test('合法 Answer 转发给控制台并附带缓存的 ICE candidates', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        const candidate = { candidate: 'candidate:1', sdpMid: '0' };
        WebRTC.pendingConnections.set('c1:d1', {
            consoleId: 'c1', consoleWs, offer: {}, candidates: [candidate], allowedViewers: new Set(), answer: null
        });
        const answerSdp = { type: 'answer', sdp: 'v=0' };
        WebRTC.handleAnswer('w1', { deviceId: 'c1:d1', sdp: answerSdp }, consoleClients, new Map());

        assert.strictEqual(consoleWs.sent.length, 2);
        assert.deepStrictEqual(consoleWs.sent[0], { type: 'webrtc-answer', deviceId: 'c1:d1', sdp: answerSdp });
        assert.deepStrictEqual(consoleWs.sent[1], { type: 'webrtc-ice-candidate', deviceId: 'c1:d1', candidate });
    });

    test('控制台离线时不转发', () => {
        const consoleClients = new Map([['c1', { ws: makeWs(3) }]]);
        WebRTC.pendingConnections.set('c1:d1', {
            consoleId: 'c1', consoleWs: consoleClients.get('c1').ws, offer: {}, candidates: [], allowedViewers: new Set(), answer: null
        });
        WebRTC.handleAnswer('w1', { deviceId: 'c1:d1', sdp: { type: 'answer' } }, consoleClients, new Map());
        assert.strictEqual(consoleClients.get('c1').ws.sent.length, 0);
    });
});

describe('handleIceCandidate', () => {
    test('缺少 deviceId 或 candidate 时忽略', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        WebRTC.handleIceCandidate('c1', { deviceId: '', candidate: { x: 1 }, from: 'console' }, consoleClients, new Map());
        WebRTC.handleIceCandidate('c1', { deviceId: 'c1:d1', candidate: null, from: 'console' }, consoleClients, new Map());
        assert.strictEqual(consoleWs.sent.length, 0);
    });

    test('控制台发送非本机设备的 candidate 被拦截', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        const watcherWs = makeWs();
        const webClients = new Map([['w1', makeWebClient('c2:d1', watcherWs)]]);
        WebRTC.handleIceCandidate('c1', { deviceId: 'c2:d1', candidate: { c: 1 }, from: 'console' }, consoleClients, webClients);
        assert.strictEqual(watcherWs.sent.length, 0);
    });

    test('控制台 candidate 转发给所有观看该设备的 Web 客户端', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        const wsA = makeWs();
        const wsB = makeWs();
        const webClients = new Map([
            ['w1', makeWebClient('c1:d1', wsA)],
            ['w2', makeWebClient('c1:d1', wsB)]
        ]);
        WebRTC.handleIceCandidate('c1', { deviceId: 'c1:d1', candidate: { c: 1 }, from: 'console' }, consoleClients, webClients);
        assert.strictEqual(wsA.sent.length, 1);
        assert.strictEqual(wsB.sent.length, 1);
        assert.deepStrictEqual(wsA.sent[0], { type: 'webrtc-ice-candidate', deviceId: 'c1:d1', candidate: { c: 1 } });
    });

    test('无 Web 观看者时缓存 candidate 待 answer 后补发', () => {
        const consoleWs = makeWs();
        WebRTC.pendingConnections.set('c1:d1', {
            consoleId: 'c1', consoleWs, offer: {}, candidates: [], allowedViewers: new Set(), answer: null
        });
        WebRTC.handleIceCandidate('c1', { deviceId: 'c1:d1', candidate: { c: 1 }, from: 'console' }, new Map(), new Map());
        const conn = WebRTC.pendingConnections.get('c1:d1');
        assert.deepStrictEqual(conn.candidates, [{ c: 1 }]);
    });

    test('Web 客户端未选看该设备时发送 candidate 被拦截', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        const webClients = new Map([['w1', makeWebClient('c1:other', makeWs())]]);
        WebRTC.handleIceCandidate('w1', { deviceId: 'c1:d1', candidate: { c: 1 }, from: 'web' }, consoleClients, webClients);
        assert.strictEqual(consoleWs.sent.length, 0);
    });

    test('合法 Web candidate 转发给控制台', () => {
        const consoleWs = makeWs();
        const consoleClients = new Map([['c1', { ws: consoleWs }]]);
        const webClients = new Map([['w1', makeWebClient('c1:d1', makeWs())]]);
        WebRTC.handleIceCandidate('w1', { deviceId: 'c1:d1', candidate: { c: 2 }, from: 'web' }, consoleClients, webClients);
        assert.deepStrictEqual(consoleWs.sent[0], {
            type: 'webrtc-ice-candidate', deviceId: 'c1:d1', candidate: { c: 2 }
        });
    });

    test('控制台不在线时 Web candidate 被丢弃且不报错', () => {
        const webClients = new Map([['w1', makeWebClient('c1:d1', makeWs())]]);
        WebRTC.handleIceCandidate('w1', { deviceId: 'c1:d1', candidate: { c: 3 }, from: 'web' }, new Map(), webClients);
    });
});

describe('cleanupConnection', () => {
    test('清理已存在设备的连接信息', () => {
        WebRTC.pendingConnections.set('c1:d1', { offer: {} });
        WebRTC.cleanupConnection('c1:d1');
        assert.strictEqual(WebRTC.pendingConnections.has('c1:d1'), false);
    });

    test('清理不存在的设备不报错', () => {
        WebRTC.cleanupConnection('no-such-device');
    });
});

describe('getTurnConfig', () => {
    test('缺少用户名或凭证时返回 null', () => {
        assert.strictEqual(WebRTC.getTurnConfig(), null);
        assert.strictEqual(WebRTC.getTurnConfig({ username: 'u' }), null);
        assert.strictEqual(WebRTC.getTurnConfig({ credential: 'p' }), null);
    });

    test('配置完整时返回 turn URL 与凭证', () => {
        const cfg = WebRTC.getTurnConfig({ host: '1.2.3.4', port: 3478, username: 'u', credential: 'p' });
        assert.deepStrictEqual(cfg, { url: 'turn:1.2.3.4:3478', username: 'u', credential: 'p' });
    });

    test('端口缺省时为 3478，主机缺省时为 localhost', () => {
        const cfg = WebRTC.getTurnConfig({ username: 'u', credential: 'p' });
        assert.strictEqual(cfg.url, 'turn:localhost:3478');
    });
});

describe('generateTurnCredentials', () => {
    test('用户名为过期时间戳，凭证为对应 HMAC-SHA1', () => {
        const before = Math.floor(Date.now() / 1000);
        const { username, credential, timestamp } = WebRTC.generateTurnCredentials('secret', 600);
        const after = Math.floor(Date.now() / 1000);
        assert.strictEqual(timestamp, Number(username));
        assert.ok(Number(username) >= before + 600 - 1 && Number(username) <= after + 600 + 1);
        const expected = crypto.createHmac('sha1', 'secret').update(username).digest('base64');
        assert.strictEqual(credential, expected);
    });

    test('不同密钥生成不同凭证', () => {
        const a = WebRTC.generateTurnCredentials('secret-a', 60);
        const b = WebRTC.generateTurnCredentials('secret-b', 60);
        assert.notStrictEqual(a.credential, b.credential);
    });

    test('默认有效期为 86400 秒', () => {
        const now = Math.floor(Date.now() / 1000);
        const { timestamp } = WebRTC.generateTurnCredentials('s');
        assert.ok(timestamp - now > 86000 && timestamp - now <= 86500);
    });
});
