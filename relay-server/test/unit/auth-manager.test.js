'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const AuthManager = require('../../auth-manager');

// 临时目录：每个用例使用独立的 auth-config.json，避免污染仓库真实配置
function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'auth-manager-test-'));
}

// 构造带一个已知用户的配置文件
async function writeConfigWithUser(dir, user = { username: 'alice', password: 's3cret!', role: 'admin' }) {
    const configPath = path.join(dir, 'auth-config.json');
    const config = {
        users: [{
            username: user.username,
            passwordHash: await bcrypt.hash(user.password, 10),
            role: user.role,
            createdAt: new Date().toISOString()
        }],
        sessionConfig: { secret: 'test-secret', cookieName: 'sid', sessionTimeout: 3600000 },
        security: { maxLoginAttempts: 3, lockoutTime: 1000 }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
}

// 模拟 express res 对象，记录 status/json/redirect 调用
function makeRes() {
    return {
        statusCode: null,
        body: null,
        redirectUrl: null,
        status(code) { this.statusCode = code; return this; },
        json(obj) { this.body = obj; return this; },
        redirect(url) { this.redirectUrl = url; return this; }
    };
}

describe('AuthManager 配置加载', () => {
    let dir;
    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('配置文件不存在时使用安全默认值', () => {
        const mgr = new AuthManager(path.join(dir, 'missing.json'));
        assert.deepStrictEqual(mgr.config, { users: [], sessionConfig: {}, security: {} });
    });

    test('配置文件损坏（非法 JSON）时降级为默认值而不抛异常', () => {
        const configPath = path.join(dir, 'auth-config.json');
        fs.writeFileSync(configPath, '{ not valid json');
        const mgr = new AuthManager(configPath);
        assert.deepStrictEqual(mgr.config, { users: [], sessionConfig: {}, security: {} });
    });

    test('合法配置被完整加载', async () => {
        const configPath = await writeConfigWithUser(dir);
        const mgr = new AuthManager(configPath);
        assert.strictEqual(mgr.config.users.length, 1);
        assert.strictEqual(mgr.config.users[0].username, 'alice');
        assert.strictEqual(mgr.config.sessionConfig.secret, 'test-secret');
        assert.strictEqual(mgr.config.security.maxLoginAttempts, 3);
    });

    test('saveConfig 将内存中的配置写回磁盘', async () => {
        const configPath = await writeConfigWithUser(dir);
        const mgr = new AuthManager(configPath);
        mgr.config.security.maxLoginAttempts = 9;
        mgr.saveConfig();
        const reloaded = new AuthManager(configPath);
        assert.strictEqual(reloaded.config.security.maxLoginAttempts, 9);
    });

    test('getSessionConfig 返回会话配置', async () => {
        const configPath = await writeConfigWithUser(dir);
        const mgr = new AuthManager(configPath);
        assert.deepStrictEqual(mgr.getSessionConfig(), { secret: 'test-secret', cookieName: 'sid', sessionTimeout: 3600000 });
    });
});

describe('AuthManager 密码处理', () => {
    let mgr;
    beforeEach(() => { mgr = new AuthManager(path.join(makeTmpDir(), 'none.json')); });

    test('hashPassword 生成可校验的 bcrypt 哈希', async () => {
        const hash = await mgr.hashPassword('my-password');
        assert.notStrictEqual(hash, 'my-password');
        assert.ok(await mgr.comparePassword('my-password', hash));
    });

    test('comparePassword 对错误密码返回 false', async () => {
        const hash = await mgr.hashPassword('my-password');
        assert.ok(!await mgr.comparePassword('wrong-password', hash));
    });
});

describe('AuthManager 登录失败锁定', () => {
    let dir, mgr;
    beforeEach(async () => {
        dir = makeTmpDir();
        const configPath = await writeConfigWithUser(dir); // maxLoginAttempts=3, lockoutTime=1000ms
        mgr = new AuthManager(configPath);
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('未达到阈值前不锁定', () => {
        mgr.recordLoginAttempt('k', false);
        mgr.recordLoginAttempt('k', false);
        assert.strictEqual(mgr.isLockedOut('k'), false);
    });

    test('达到最大失败次数后锁定', () => {
        for (let i = 0; i < 3; i++) mgr.recordLoginAttempt('k', false);
        assert.strictEqual(mgr.isLockedOut('k'), true);
    });

    test('不同 key 互相独立', () => {
        for (let i = 0; i < 3; i++) mgr.recordLoginAttempt('k1', false);
        assert.strictEqual(mgr.isLockedOut('k1'), true);
        assert.strictEqual(mgr.isLockedOut('k2'), false);
    });

    test('登录成功清除失败计数', () => {
        mgr.recordLoginAttempt('k', false);
        mgr.recordLoginAttempt('k', false);
        mgr.recordLoginAttempt('k', true);
        assert.strictEqual(mgr.isLockedOut('k'), false);
        // 成功后计数清零：再失败 2 次仍未达阈值 3
        mgr.recordLoginAttempt('k', false);
        mgr.recordLoginAttempt('k', false);
        assert.strictEqual(mgr.isLockedOut('k'), false);
    });

    test('锁定期过后自动解锁', () => {
        for (let i = 0; i < 3; i++) mgr.recordLoginAttempt('k', false);
        // lockoutTime=1000ms，把最后一次尝试时间拨回 2 秒前
        mgr.loginAttempts.get('k').lastAttempt = Date.now() - 2000;
        assert.strictEqual(mgr.isLockedOut('k'), false);
    });

    test('cleanupExpiredAttempts 清理过期记录', () => {
        mgr.recordLoginAttempt('old', false);
        mgr.recordLoginAttempt('fresh', false);
        mgr.loginAttempts.get('old').lastAttempt = Date.now() - 5000;
        mgr.cleanupExpiredAttempts();
        assert.strictEqual(mgr.loginAttempts.has('old'), false);
        assert.strictEqual(mgr.loginAttempts.has('fresh'), true);
    });
});

describe('AuthManager.authenticate', () => {
    let dir, mgr;
    beforeEach(async () => {
        dir = makeTmpDir();
        const configPath = await writeConfigWithUser(dir); // user: alice / s3cret! (admin)
        mgr = new AuthManager(configPath);
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('正确用户名和密码登录成功并返回角色', async () => {
        const result = await mgr.authenticate('alice', 's3cret!');
        assert.deepStrictEqual(result, { success: true, user: { username: 'alice', role: 'admin' } });
    });

    test('用户不存在时返回失败（不泄露用户名是否存在）', async () => {
        const result = await mgr.authenticate('nobody', 'whatever');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.message, '用户名或密码错误');
    });

    test('密码错误时返回失败', async () => {
        const result = await mgr.authenticate('alice', 'wrong');
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.message, '用户名或密码错误');
    });

    test('带 clientIp 时失败计数按 IP+用户名隔离', async () => {
        for (let i = 0; i < 3; i++) await mgr.authenticate('alice', 'bad', '10.0.0.1');
        assert.strictEqual(mgr.isLockedOut('10.0.0.1:alice'), true);
        // 其他 IP 上的同名账号不受影响
        const result = await mgr.authenticate('alice', 's3cret!', '10.0.0.2');
        assert.strictEqual(result.success, true);
    });

    test('锁定期间即使密码正确也拒绝登录', async () => {
        for (let i = 0; i < 3; i++) await mgr.authenticate('alice', 'bad');
        const result = await mgr.authenticate('alice', 's3cret!');
        assert.strictEqual(result.success, false);
        assert.match(result.message, /锁定/);
    });
});

describe('AuthManager.hasRole', () => {
    test('无用户返回 false', () => {
        assert.strictEqual(new (require('../../auth-manager'))(path.join(os.tmpdir(), 'none.json')).hasRole(null, 'user'), false);
    });

    test('admin 拥有任何角色权限', () => {
        const mgr = new AuthManager(path.join(os.tmpdir(), 'none.json'));
        assert.strictEqual(mgr.hasRole({ role: 'admin' }, 'user'), true);
    });

    test('普通角色需精确匹配', () => {
        const mgr = new AuthManager(path.join(os.tmpdir(), 'none.json'));
        assert.strictEqual(mgr.hasRole({ role: 'user' }, 'user'), true);
        assert.strictEqual(mgr.hasRole({ role: 'user' }, 'admin'), false);
    });
});

describe('AuthManager.requireAuth 中间件', () => {
    const mgr = new AuthManager(path.join(os.tmpdir(), 'none.json'));

    test('已登录会话直接放行', () => {
        const req = { session: { user: { username: 'alice' } } };
        const res = makeRes();
        let nextCalled = false;
        mgr.requireAuth(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
    });

    test('未登录的 JSON 请求返回 401 JSON 错误', () => {
        const req = { headers: { accept: 'application/json' }, xhr: false };
        const res = makeRes();
        mgr.requireAuth(req, res, () => { throw new Error('不应放行'); });
        assert.strictEqual(res.statusCode, 401);
        assert.deepStrictEqual(res.body, { error: '未授权访问' });
    });

    test('未登录的 XHR 请求返回 401', () => {
        const req = { headers: {}, xhr: true };
        const res = makeRes();
        mgr.requireAuth(req, res, () => { throw new Error('不应放行'); });
        assert.strictEqual(res.statusCode, 401);
    });

    test('未登录的普通页面请求重定向到 /login', () => {
        const req = { headers: {}, xhr: false };
        const res = makeRes();
        mgr.requireAuth(req, res, () => { throw new Error('不应放行'); });
        assert.strictEqual(res.redirectUrl, '/login');
    });
});

describe('AuthManager.requireRole 中间件', () => {
    const mgr = new AuthManager(path.join(os.tmpdir(), 'none.json'));

    test('角色匹配时放行', () => {
        const req = { session: { user: { username: 'a', role: 'admin' } } };
        const res = makeRes();
        let nextCalled = false;
        mgr.requireRole('admin')(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
    });

    test('角色不匹配返回 403', () => {
        const req = { session: { user: { username: 'a', role: 'user' } } };
        const res = makeRes();
        mgr.requireRole('admin')(req, res, () => { throw new Error('不应放行'); });
        assert.strictEqual(res.statusCode, 403);
    });

    test('未登录返回 403', () => {
        const req = {};
        const res = makeRes();
        mgr.requireRole('admin')(req, res, () => { throw new Error('不应放行'); });
        assert.strictEqual(res.statusCode, 403);
    });
});

describe('AuthManager.addUser', () => {
    let dir, configPath;
    beforeEach(async () => {
        dir = makeTmpDir();
        configPath = await writeConfigWithUser(dir);
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('添加新用户并持久化到磁盘', async () => {
        const mgr = new AuthManager(configPath);
        const user = await mgr.addUser('bob', 'bob-pass', 'user');
        assert.strictEqual(user.username, 'bob');
        assert.strictEqual(user.role, 'user');
        assert.ok(await mgr.comparePassword('bob-pass', user.passwordHash));

        // 新实例重新读盘应看到新用户
        const reloaded = new AuthManager(configPath);
        const result = await reloaded.authenticate('bob', 'bob-pass');
        assert.strictEqual(result.success, true);
    });

    test('默认角色为 user', async () => {
        const mgr = new AuthManager(configPath);
        const user = await mgr.addUser('carol', 'carol-pass');
        assert.strictEqual(user.role, 'user');
    });

    test('重复用户名抛出异常', async () => {
        const mgr = new AuthManager(configPath);
        await assert.rejects(() => mgr.addUser('alice', 'another-pass'), /用户已存在/);
    });
});
