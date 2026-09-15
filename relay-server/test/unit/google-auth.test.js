'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// 被测模块在加载时读取部分 GOOGLE_* 环境变量，工具函数负责保存/恢复环境
// 并在需要时清除 require 缓存以重新加载模块。
const MODULE_PATH = require.resolve('../../google-auth');

function loadFresh() {
    delete require.cache[MODULE_PATH];
    return require(MODULE_PATH);
}

// 修改环境变量执行 fn（可为异步），结束后恢复原值并清除模块缓存。
// 必须全程包住测试体：部分逻辑（如 usingRelay）在调用时读取环境变量。
async function withEnv(overrides, fn) {
    const saved = {};
    for (const key of Object.keys(overrides)) {
        saved[key] = process.env[key];
        if (overrides[key] === undefined) delete process.env[key];
        else process.env[key] = overrides[key];
    }
    try {
        return await fn();
    } finally {
        for (const key of Object.keys(saved)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        delete require.cache[MODULE_PATH];
    }
}

// stub 全局 fetch，记录请求并返回预设响应
function stubFetch(responses) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const res = Array.isArray(responses) ? responses[calls.length] : responses;
        calls.push({ url, options, resJson: res.json });
        return {
            ok: res.ok !== false,
            status: res.status || 200,
            text: async () => res.text || '',
            json: async () => res.json
        };
    };
    return {
        calls,
        restore() { globalThis.fetch = original; }
    };
}

describe('Google OAuth 配置解析', () => {
    test('未配置任何环境变量时全部为空（fail closed）', () => {
        withEnv({
            GOOGLE_CLIENT_ID: undefined,
            GOOGLE_CLIENT_SECRET: undefined,
            GOOGLE_REDIRECT_URI: undefined,
            ADMIN_EMAIL: undefined
        }, () => {
            const g = loadFresh();
            assert.deepStrictEqual(g.getGoogleOAuthConfig(), {
                clientId: '', clientSecret: '', redirectUri: '', adminEmail: ''
            });
            assert.strictEqual(g.isGoogleOAuthConfigured(), false);
        });
    });

    test('完整配置时判定为已配置', () => {
        withEnv({
            GOOGLE_CLIENT_ID: 'my-client-id',
            GOOGLE_CLIENT_SECRET: 'my-secret',
            ADMIN_EMAIL: 'admin@example.com'
        }, () => {
            const g = loadFresh();
            const cfg = g.getGoogleOAuthConfig();
            assert.strictEqual(cfg.clientId, 'my-client-id');
            assert.strictEqual(cfg.clientSecret, 'my-secret');
            assert.strictEqual(cfg.adminEmail, 'admin@example.com');
            assert.strictEqual(g.isGoogleOAuthConfigured(), true);
        });
    });

    test('管理员邮箱归一化为小写', () => {
        withEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', ADMIN_EMAIL: 'Admin@Example.COM' }, () => {
            const g = loadFresh();
            assert.strictEqual(g.getGoogleOAuthConfig().adminEmail, 'admin@example.com');
        });
    });

    test('缺少任一密钥/白名单都视为未配置', () => {
        withEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: '', ADMIN_EMAIL: 'x@y.z' }, () => {
            assert.strictEqual(loadFresh().isGoogleOAuthConfigured(), false);
        });
        withEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: 'b', ADMIN_EMAIL: 'x@y.z' }, () => {
            assert.strictEqual(loadFresh().isGoogleOAuthConfigured(), false);
        });
        withEnv({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', ADMIN_EMAIL: '' }, () => {
            assert.strictEqual(loadFresh().isGoogleOAuthConfigured(), false);
        });
    });
});

describe('Google OAuth 授权工具函数', () => {
    const g = loadFresh();

    test('generateState 生成 32 位十六进制随机串且不重复', () => {
        const s1 = g.generateState();
        const s2 = g.generateState();
        assert.match(s1, /^[0-9a-f]{32}$/);
        assert.match(s2, /^[0-9a-f]{32}$/);
        assert.notStrictEqual(s1, s2);
    });

    test('generatePkcePair 的 challenge 等于 verifier 的 SHA-256 base64url', () => {
        const { verifier, challenge } = g.generatePkcePair();
        // 32 字节 base64url 无填充恒为 43 字符
        assert.strictEqual(verifier.length, 43);
        assert.match(verifier, /^[A-Za-z0-9_-]+$/);
        const expected = crypto.createHash('sha256').update(verifier).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        assert.strictEqual(challenge, expected);
    });

    test('getGoogleAuthUrl 携带全部必需参数', () => {
        const url = new URL(g.getGoogleAuthUrl({
            clientId: 'cid',
            redirectUri: 'https://example.com/callback',
            state: 'st123',
            codeChallenge: 'cc-abc'
        }));
        assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/auth');
        assert.strictEqual(url.searchParams.get('client_id'), 'cid');
        assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://example.com/callback');
        assert.strictEqual(url.searchParams.get('response_type'), 'code');
        assert.strictEqual(url.searchParams.get('scope'), 'openid email profile');
        assert.strictEqual(url.searchParams.get('state'), 'st123');
        assert.strictEqual(url.searchParams.get('code_challenge'), 'cc-abc');
        assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
        assert.strictEqual(url.searchParams.get('access_type'), 'online');
        assert.strictEqual(url.searchParams.get('prompt'), 'select_account');
    });

    test('timingSafeEqualStr：相同字符串为 true', () => {
        assert.strictEqual(g.timingSafeEqualStr('abc123', 'abc123'), true);
    });

    test('timingSafeEqualStr：不同内容为 false', () => {
        assert.strictEqual(g.timingSafeEqualStr('abc123', 'xyz789'), false);
    });

    test('timingSafeEqualStr：长度不同为 false', () => {
        assert.strictEqual(g.timingSafeEqualStr('short', 'a-much-longer-string'), false);
    });

    test('timingSafeEqualStr：空串与空值返回 false（而非相等）', () => {
        assert.strictEqual(g.timingSafeEqualStr('', ''), false);
        assert.strictEqual(g.timingSafeEqualStr(null, null), false);
        assert.strictEqual(g.timingSafeEqualStr(undefined, undefined), false);
    });
});

describe('exchangeGoogleCode（直连 Google 模式）', () => {
    test('成功时以表单格式提交并返回 JSON', async (t) => {
        t.mock.method(console, 'error', () => {});
        const stub = stubFetch({ json: { access_token: 'at', token_type: 'Bearer' } });
        try {
            await withEnv({ GOOGLE_TOKEN_URL: undefined }, async () => {
                const g = loadFresh();
                await g.exchangeGoogleCode({
                    code: 'auth-code', clientId: 'cid', clientSecret: 'sec',
                    redirectUri: 'https://x/cb', codeVerifier: 'ver'
                });
            });
            assert.deepStrictEqual(stub.calls[0].resJson, { access_token: 'at', token_type: 'Bearer' });
            assert.strictEqual(stub.calls[0].url, 'https://oauth2.googleapis.com/token');
            assert.strictEqual(stub.calls[0].options.method, 'POST');
            assert.strictEqual(stub.calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
            const body = new URLSearchParams(stub.calls[0].options.body);
            assert.strictEqual(body.get('grant_type'), 'authorization_code');
            assert.strictEqual(body.get('code'), 'auth-code');
            assert.strictEqual(body.get('code_verifier'), 'ver');
            assert.strictEqual(body.get('client_id'), 'cid');
            assert.strictEqual(body.get('client_secret'), 'sec');
        } finally {
            stub.restore();
        }
    });

    test('失败时抛出的错误只含状态码，不泄露响应正文', async (t) => {
        t.mock.method(console, 'error', () => {});
        const stub = stubFetch({ ok: false, status: 400, text: 'secret-backend-detail' });
        try {
            await withEnv({ GOOGLE_TOKEN_URL: undefined }, async () => {
                const g = loadFresh();
                await assert.rejects(
                    () => g.exchangeGoogleCode({ code: 'x', clientId: 'c', clientSecret: 's', redirectUri: 'r', codeVerifier: 'v' }),
                    (err) => {
                        assert.match(err.message, /400/);
                        assert.ok(!err.message.includes('secret-backend-detail'));
                        return true;
                    }
                );
            });
        } finally {
            stub.restore();
        }
    });
});

describe('exchangeGoogleCode（中继模式，GOOGLE_TOKEN_URL 覆盖）', () => {
    test('以 JSON 提交并携带 X-Relay-Key 头', async (t) => {
        t.mock.method(console, 'error', () => {});
        const stub = stubFetch({ json: { access_token: 'at' } });
        try {
            await withEnv({
                GOOGLE_TOKEN_URL: 'https://relay.example/token',
                SCRCPY_RELAY_KEY: 'relay-key-1'
            }, async () => {
                const g = loadFresh();
                await g.exchangeGoogleCode({
                    code: 'auth-code', clientId: 'cid', clientSecret: 'sec',
                    redirectUri: 'https://x/cb', codeVerifier: 'ver'
                });
            });
            assert.strictEqual(stub.calls[0].url, 'https://relay.example/token');
            assert.strictEqual(stub.calls[0].options.headers['Content-Type'], 'application/json');
            assert.strictEqual(stub.calls[0].options.headers['X-Relay-Key'], 'relay-key-1');
            const body = JSON.parse(stub.calls[0].options.body);
            assert.strictEqual(body.grant_type, 'authorization_code');
        } finally {
            stub.restore();
        }
    });
});

describe('getGoogleUserInfo', () => {
    test('成功时携带 Bearer Token 请求 userinfo', async (t) => {
        t.mock.method(console, 'error', () => {});
        const stub = stubFetch({ json: { email: 'u@gmail.com', id: '123' } });
        try {
            await withEnv({ SCRCPY_RELAY_KEY: undefined }, async () => {
                const g = loadFresh();
                const info = await g.getGoogleUserInfo('token-abc');
                assert.deepStrictEqual(info, { email: 'u@gmail.com', id: '123' });
            });
            assert.strictEqual(stub.calls[0].url, 'https://www.googleapis.com/oauth2/v2/userinfo');
            assert.strictEqual(stub.calls[0].options.headers.Authorization, 'Bearer token-abc');
        } finally {
            stub.restore();
        }
    });

    test('失败时抛出可安全展示的错误', async (t) => {
        t.mock.method(console, 'error', () => {});
        const stub = stubFetch({ ok: false, status: 401, text: 'backend-only' });
        try {
            await withEnv({ SCRCPY_RELAY_KEY: undefined }, async () => {
                const g = loadFresh();
                await assert.rejects(
                    () => g.getGoogleUserInfo('bad-token'),
                    /Google userinfo request failed \(401\)/
                );
            });
        } finally {
            stub.restore();
        }
    });
});
