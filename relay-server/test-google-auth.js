/**
 * Google OAuth 登录流程冒烟测试（自包含：自动拉起被测服务器与 mock Google 端点）
 *
 * 覆盖场景：
 *  1. 未配置 OAuth 凭据时 /api/auth/google/status 返回 enabled:false
 *  2. 配置后发起登录：302 跳转 Google，URL 携带 client_id/state/PKCE
 *  3. state 不匹配的回调被拒绝
 *  4. 白名单内账号：登录成功写入会话，/api/user 可用，主页可访问
 *  5. 白名单外账号：被拒绝并回到登录页（防枚举提示）
 *
 * 运行：node test-google-auth.js
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const HTTP_PORT = 8899;
const MOCK_PORT = 8900;
const BASE = `http://localhost:${HTTP_PORT}`;
const ADMIN_EMAIL = '0pfcmail@gmail.com';
const OTHER_EMAIL = 'attacker@example.com';

// 每个用例可切换 mock userinfo 返回的邮箱
let mockUserEmail = ADMIN_EMAIL;

function startMockGoogle() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url.startsWith('/token')) {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => {
                    const params = new URLSearchParams(body);
                    if (!params.get('code_verifier')) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: 'missing code_verifier' }));
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600, token_type: 'Bearer' }));
                });
            } else if (req.url.startsWith('/userinfo')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'mock-id',
                    email: mockUserEmail,
                    verified_email: true,
                    name: mockUserEmail.split('@')[0],
                    picture: 'https://example.com/avatar.png'
                }));
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        server.listen(MOCK_PORT, () => resolve(server));
    });
}

function startRelayServer(extraEnv) {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        env: {
            ...process.env,
            HTTP_PORT: String(HTTP_PORT),
            ENABLE_HTTPS: 'false',
            LOG_LEVEL: 'ERROR',
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', (d) => process.stderr.write(`[relay] ${d}`));
    return child;
}

function waitForServer(url, timeoutMs = 8000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const probe = async () => {
            try {
                await fetch(url);
                resolve();
            } catch {
                if (Date.now() - start > timeoutMs) return reject(new Error('server start timeout'));
                setTimeout(probe, 200);
            }
        };
        probe();
    });
}

// 极简 cookie jar
function createJar() {
    const map = new Map();
    return {
        absorb(res) {
            const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
            for (const c of setCookies) {
                const [pair] = c.split(';');
                const eq = pair.indexOf('=');
                if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
        },
        header() {
            return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
        }
    };
}

async function assert(name, cond, detail = '') {
    if (cond) {
        console.log(`  ✓ ${name}`);
    } else {
        console.error(`  ✗ ${name} ${detail}`);
        process.exitCode = 1;
    }
}

async function initiateLogin(jar) {
    const res = await fetch(`${BASE}/api/auth/google`, { redirect: 'manual', headers: { Cookie: jar.header() } });
    jar.absorb(res);
    const location = res.headers.get('location') || '';
    const state = new URL(location).searchParams.get('state');
    return { res, location, state };
}

async function runCallback(jar, state, code = 'mock-auth-code') {
    const res = await fetch(`${BASE}/api/auth/google/callback?code=${code}&state=${encodeURIComponent(state || '')}`, {
        redirect: 'manual',
        headers: { Cookie: jar.header() }
    });
    jar.absorb(res);
    return res;
}

async function main() {
    const mockServer = await startMockGoogle();
    const env = {
        GOOGLE_CLIENT_ID: 'test-client-id',
        GOOGLE_CLIENT_SECRET: 'test-client-secret',
        ADMIN_EMAIL,
        GOOGLE_AUTH_URL: 'https://accounts.google.com/o/oauth2/auth', // 真实地址，仅验证跳转参数
        GOOGLE_TOKEN_URL: `http://localhost:${MOCK_PORT}/token`,
        GOOGLE_USERINFO_URL: `http://localhost:${MOCK_PORT}/userinfo`
    };

    console.log('\n=== 场景 0：未配置凭据时 status 应为 disabled ===');
    const childNoCfg = startRelayServer({ ...env, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ADMIN_EMAIL: '' });
    try {
        await waitForServer(BASE);
        const s = await (await fetch(`${BASE}/api/auth/google/status`)).json();
        await assert('未配置时 enabled=false', s.enabled === false, JSON.stringify(s));
    } finally {
        childNoCfg.kill();
        await new Promise((r) => setTimeout(r, 300));
    }

    console.log('\n=== 启动被测服务器（已配置凭据） ===');
    const child = startRelayServer(env);
    await waitForServer(BASE);

    console.log('\n=== 场景 1：status 接口 ===');
    {
        const s = await (await fetch(`${BASE}/api/auth/google/status`)).json();
        await assert('已配置时 enabled=true', s.enabled === true, JSON.stringify(s));
    }

    console.log('\n=== 场景 2：发起登录跳转参数 ===');
    const jar1 = createJar();
    {
        const { res, location, state } = await initiateLogin(jar1);
        const url = new URL(location);
        await assert('302 跳转 Google', res.status === 302 && url.origin === 'https://accounts.google.com', `status=${res.status}`);
        await assert('client_id 正确', url.searchParams.get('client_id') === 'test-client-id');
        await assert('回调地址按 origin 推导', url.searchParams.get('redirect_uri') === `${BASE}/api/auth/google/callback`, url.searchParams.get('redirect_uri'));
        await assert('携带 PKCE S256', url.searchParams.get('code_challenge_method') === 'S256' && !!url.searchParams.get('code_challenge'));
        await assert('下发了会话 cookie', jar1.header().includes('scrcpy.sid='));
        await assert('state 已生成', !!state);
    }

    console.log('\n=== 场景 3：state 不匹配被拒绝 ===');
    {
        const res = await runCallback(jar1, 'wrong-state-123');
        const location = res.headers.get('location') || '';
        await assert('302 回登录页', res.status === 302 && location.startsWith('/login?error='), `status=${res.status} loc=${location}`);
        await assert('错误提示为防枚举文案', decodeURIComponent(location).includes('重新发起登录'));
    }

    console.log('\n=== 场景 4：白名单账号登录成功 ===');
    {
        mockUserEmail = ADMIN_EMAIL;
        const jar = createJar();
        const { state } = await initiateLogin(jar);
        const cb = await runCallback(jar, state);
        await assert('回调成功跳转主页 /', cb.status === 302 && cb.headers.get('location') === '/', `status=${cb.status} loc=${cb.headers.get('location')}`);

        const me = await fetch(`${BASE}/api/user`, { headers: { Cookie: jar.header() } });
        const meBody = await me.json();
        await assert('/api/user 返回 200', me.status === 200, `status=${me.status}`);
        await assert('用户名为白名单邮箱', meBody.user && meBody.user.username === ADMIN_EMAIL, JSON.stringify(meBody));
        await assert('标记了 google 认证来源', meBody.user && meBody.user.authProvider === 'google');

        const home = await fetch(`${BASE}/`, { headers: { Cookie: jar.header() }, redirect: 'manual' });
        await assert('主页已放行', home.status === 200, `status=${home.status}`);
    }

    console.log('\n=== 场景 5：白名单外账号被拒绝 ===');
    {
        mockUserEmail = OTHER_EMAIL;
        const jar = createJar();
        const { state } = await initiateLogin(jar);
        const cb = await runCallback(jar, state);
        const location = decodeURIComponent(cb.headers.get('location') || '');
        await assert('拒绝并回登录页', cb.status === 302 && location.startsWith('/login?error='), `status=${cb.status}`);
        await assert('提示不含期望账号（防枚举）', !location.includes(ADMIN_EMAIL));
        await assert('提示为未授权文案', location.includes('未获得此系统的授权'));

        const me = await fetch(`${BASE}/api/user`, { headers: { Cookie: jar.header() }, redirect: 'manual' });
        await assert('会话未获得授权（跳转登录页）', me.status === 302 && (me.headers.get('location') || '').startsWith('/login'), `status=${me.status}`);
    }

    child.kill();
    mockServer.close();

    const failed = process.exitCode === 1;
    console.log(failed ? '\n结果：存在失败用例 ✗' : '\n结果：全部通过 ✓');
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error('测试执行异常:', err);
    process.exit(1);
});
