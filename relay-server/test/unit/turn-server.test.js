'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const TurnServer = require('../../turn-server');

describe('TURN 凭证生成', () => {
    test('generateTimestampUsername 为当前时间加 TTL 的时间戳', () => {
        const before = Math.floor(Date.now() / 1000);
        const username = TurnServer.generateTimestampUsername(120);
        const after = Math.floor(Date.now() / 1000);
        assert.ok(Number(username) >= before + 120 && Number(username) <= after + 120);
    });

    test('generateTimestampUsername 默认 TTL 为 86400 秒', () => {
        const now = Math.floor(Date.now() / 1000);
        assert.ok(Number(TurnServer.generateTimestampUsername()) - now > 86000);
    });

    test('generateCredential 等于 HMAC-SHA1(username, secret) 的 base64', () => {
        const credential = TurnServer.generateCredential('1700000000', 'my-secret');
        const expected = crypto.createHmac('sha1', 'my-secret').update('1700000000').digest('base64');
        assert.strictEqual(credential, expected);
    });

    test('不同用户名或密钥产生不同凭证', () => {
        assert.notStrictEqual(
            TurnServer.generateCredential('1700000000', 's1'),
            TurnServer.generateCredential('1700000001', 's1')
        );
        assert.notStrictEqual(
            TurnServer.generateCredential('1700000000', 's1'),
            TurnServer.generateCredential('1700000000', 's2')
        );
    });
});

describe('TURN 服务器生命周期（未初始化状态）', () => {
    test('初始状态未运行', () => {
        assert.strictEqual(TurnServer.isTurnRunning(), false);
    });

    test('未初始化时 getTurnConfig 返回 null', () => {
        assert.strictEqual(TurnServer.getTurnConfig(), null);
    });
});

describe('TURN 服务器初始化', () => {
    test('enabled=false 时不启动并返回 false', async () => {
        const result = await TurnServer.initTurnServer({ enabled: false });
        assert.strictEqual(result, false);
        assert.strictEqual(TurnServer.isTurnRunning(), false);
        assert.strictEqual(TurnServer.getTurnConfig(), null);
    });

    test('启用后启动成功、可获取配置并正常停止', async () => {
        const started = await TurnServer.initTurnServer({
            enabled: true,
            port: 13478, // 测试专用高位端口，避免与本机服务冲突
            secret: 'test-turn-secret',
            realm: 'test.local'
        });
        try {
            assert.strictEqual(started, true);
            assert.strictEqual(TurnServer.isTurnRunning(), true);

            const cfg = TurnServer.getTurnConfig(3600);
            assert.ok(cfg, '启动后应返回 TURN 配置');
            assert.match(cfg.url, /^turn:.+:13478$/);
            assert.strictEqual(cfg.credential, TurnServer.generateCredential(cfg.username, 'test-turn-secret'));
            // getTurnConfig 每次生成新的短期凭证，username 为时间戳
            assert.match(cfg.username, /^\d+$/);
        } finally {
            TurnServer.stopTurnServer();
        }
        assert.strictEqual(TurnServer.isTurnRunning(), false);
        assert.strictEqual(TurnServer.getTurnConfig(), null);
    });
});
