'use strict';

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helpers = require('../../lib/helpers');

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'helpers-test-'));
}

// 构造带端口信息的 H.264 Annex-B NAL 起始码
const START3 = [0x00, 0x00, 0x01];              // 3 字节起始码
const START4 = [0x00, 0x00, 0x00, 0x01];        // 4 字节起始码
const NAL_IDR = 0x65;                            // NAL type 5 (IDR) + NRI 0x60
const NAL_SLICE = 0x41;                          // NAL type 1 (非 IDR slice)
const NAL_SPS = 0x67;                            // NAL type 7
const NAL_PPS = 0x68;                            // NAL type 8

function buf(...bytes) { return Buffer.from(bytes); }

describe('makeLog 日志级别过滤', () => {
    test('低于阈值的日志不输出', () => {
        const log = helpers.makeLog('ERROR');
        const logMock = mock.method(console, 'log', () => {});
        const errMock = mock.method(console, 'error', () => {});
        try {
            log('INFO', 'hidden');
            log('WARN', 'hidden');
            assert.strictEqual(logMock.mock.callCount(), 0);
            assert.strictEqual(errMock.mock.callCount(), 0);
            log('ERROR', 'shown');
            assert.strictEqual(errMock.mock.callCount(), 1);
        } finally {
            logMock.mock.restore();
            errMock.mock.restore();
        }
    });

    test('等于阈值的日志输出到对应通道', () => {
        const log = helpers.makeLog('INFO');
        const logMock = mock.method(console, 'log', () => {});
        const warnMock = mock.method(console, 'warn', () => {});
        try {
            log('WARN', 'to-warn');
            log('INFO', 'to-log');
            assert.strictEqual(warnMock.mock.callCount(), 1);
            assert.strictEqual(logMock.mock.callCount(), 1);
        } finally {
            logMock.mock.restore();
            warnMock.mock.restore();
        }
    });

    test('未知的当前级别导致所有日志静默（与原行为一致）', () => {
        const log = helpers.makeLog('VERBOSE');
        const logMock = mock.method(console, 'log', () => {});
        try {
            log('INFO', 'hidden');
            assert.strictEqual(logMock.mock.callCount(), 0);
        } finally {
            logMock.mock.restore();
        }
    });
});

describe('loadEnvFile', () => {
    let dir, envPath;
    beforeEach(() => { dir = makeTmpDir(); envPath = path.join(dir, '.env'); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    // 在隔离环境中加载，结束后还原被修改的环境变量
    function loadAndRestore(keys) {
        const saved = {};
        return {
            run() {
                for (const k of keys) saved[k] = process.env[k];
                helpers.loadEnvFile(envPath);
            },
            restore() {
                for (const k of keys) {
                    if (saved[k] === undefined) delete process.env[k];
                    else process.env[k] = saved[k];
                }
            }
        };
    }

    test('解析 KEY=VALUE、注释、空行与引号包裹的值', () => {
        fs.writeFileSync(envPath, [
            '# 注释行',
            '',
            'TEST_A=plain-value',
            "TEST_B='single quoted'",
            'TEST_C="double quoted"',
            'TEST_D = spaced-key = ok',  // 值中可含等号
            'no-equals-sign',
            '=empty-key-skipped'
        ].join('\n'));
        const r = loadAndRestore(['TEST_A', 'TEST_B', 'TEST_C', 'TEST_D']);
        try {
            r.run();
            assert.strictEqual(process.env.TEST_A, 'plain-value');
            assert.strictEqual(process.env.TEST_B, 'single quoted');
            assert.strictEqual(process.env.TEST_C, 'double quoted');
            assert.strictEqual(process.env.TEST_D, 'spaced-key = ok');
        } finally {
            r.restore();
        }
    });

    test('不覆盖已存在的环境变量', () => {
        fs.writeFileSync(envPath, 'TEST_EXISTING=from-file\n');
        process.env.TEST_EXISTING = 'from-env';
        try {
            helpers.loadEnvFile(envPath);
            assert.strictEqual(process.env.TEST_EXISTING, 'from-env');
        } finally {
            delete process.env.TEST_EXISTING;
        }
    });

    test('文件不存在时静默跳过', () => {
        helpers.loadEnvFile(path.join(dir, 'no-such-env'));
    });

    test('支持 CRLF 换行', () => {
        fs.writeFileSync(envPath, 'TEST_CRLF=win\r\n');
        const r = loadAndRestore(['TEST_CRLF']);
        try {
            r.run();
            assert.strictEqual(process.env.TEST_CRLF, 'win');
        } finally {
            r.restore();
        }
    });
});

describe('normalizeVideoProfile 画质档位白名单', () => {
    test('四个合法档位原样通过', () => {
        for (const p of ['original', 'interactive', 'weaknet', 'sharp']) {
            assert.strictEqual(helpers.normalizeVideoProfile(p), p);
        }
    });

    test('非法输入返回 undefined（不透传任意命令行参数）', () => {
        assert.strictEqual(helpers.normalizeVideoProfile('rm -rf /'), undefined);
        assert.strictEqual(helpers.normalizeVideoProfile(''), undefined);
        assert.strictEqual(helpers.normalizeVideoProfile(null), undefined);
        assert.strictEqual(helpers.normalizeVideoProfile(undefined), undefined);
        assert.strictEqual(helpers.normalizeVideoProfile(123), undefined);
    });
});

describe('containsH264Idr IDR 帧检测', () => {
    test('非 Buffer 与空数据返回 false', () => {
        assert.strictEqual(helpers.containsH264Idr(null), false);
        assert.strictEqual(helpers.containsH264Idr('not a buffer'), false);
        assert.strictEqual(helpers.containsH264Idr(Buffer.alloc(0)), false);
    });

    test('3 字节起始码 + IDR NAL 检出', () => {
        assert.strictEqual(helpers.containsH264Idr(buf(...START3, NAL_IDR)), true);
    });

    test('4 字节起始码 + IDR NAL 检出', () => {
        assert.strictEqual(helpers.containsH264Idr(buf(...START4, NAL_IDR)), true);
    });

    test('只有非 IDR NAL（SPS/PPS/普通 slice）不误报', () => {
        assert.strictEqual(helpers.containsH264Idr(buf(...START3, NAL_SPS, ...START3, NAL_PPS)), false);
        assert.strictEqual(helpers.containsH264Idr(buf(...START3, NAL_SLICE)), false);
    });

    test('扫描指针跳过 NAL 后仍能命中后续 IDR', () => {
        // [00 00 01 41] [00 00 01 65]：第一个 NAL 匹配后 i+=2 再 +1 应正好落在第二个起始码
        const data = buf(...START3, NAL_SLICE, ...START3, NAL_IDR);
        assert.strictEqual(helpers.containsH264Idr(data), true);
    });

    test('纯垃圾数据不误报', () => {
        assert.strictEqual(helpers.containsH264Idr(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), false);
        assert.strictEqual(helpers.containsH264Idr(Buffer.alloc(64, 0xab)), false);
    });
});

describe('extractH264ParameterSets SPS/PPS 提取', () => {
    test('同时含 SPS 和 PPS 时返回整段数据副本', () => {
        const input = buf(...START3, NAL_SPS, 0x01, 0x02, ...START3, NAL_PPS, 0x03);
        const out = helpers.extractH264ParameterSets(input);
        assert.ok(Buffer.isBuffer(out));
        assert.ok(out.equals(input));
        assert.notStrictEqual(out, input, '应返回副本而非原引用');
    });

    test('只含 SPS 也会返回', () => {
        const input = buf(...START4, NAL_SPS, 0x09);
        const out = helpers.extractH264ParameterSets(input);
        assert.ok(Buffer.isBuffer(out));
        assert.ok(out.equals(input));
    });

    test('只含 PPS 也会返回', () => {
        const input = buf(...START3, NAL_PPS);
        assert.ok(Buffer.isBuffer(helpers.extractH264ParameterSets(input)));
    });

    test('不含参数集（仅 IDR）返回 null', () => {
        assert.strictEqual(helpers.extractH264ParameterSets(buf(...START3, NAL_IDR, 0xaa)), null);
    });

    test('非 Buffer 返回 null', () => {
        assert.strictEqual(helpers.extractH264ParameterSets(undefined), null);
        assert.strictEqual(helpers.extractH264ParameterSets([0, 0, 1, 0x67]), null);
    });
});

describe('splitDeviceId 设备 ID 拆分', () => {
    test('consoleId:serial 正常拆分', () => {
        assert.deepStrictEqual(helpers.splitDeviceId('console1:9d638992'), ['console1', '9d638992']);
    });

    test('serial 为带端口 IP 时只按第一个冒号拆分', () => {
        assert.deepStrictEqual(helpers.splitDeviceId('console1:192.168.0.6:39743'), ['console1', '192.168.0.6:39743']);
    });

    test('无冒号时整体视为 serial（兼容旧前端）', () => {
        assert.deepStrictEqual(helpers.splitDeviceId('9d638992'), ['', '9d638992']);
    });

    test('空值返回空对', () => {
        assert.deepStrictEqual(helpers.splitDeviceId(''), ['', '']);
        assert.deepStrictEqual(helpers.splitDeviceId(null), ['', '']);
        assert.deepStrictEqual(helpers.splitDeviceId(undefined), ['', '']);
    });
});

describe('sendWsJson 安全发送', () => {
    test('OPEN 状态发送 JSON 字符串', () => {
        const sent = [];
        const ws = { readyState: 1, send: (d) => sent.push(d) };
        helpers.sendWsJson(ws, { type: 'hello', n: 1 });
        assert.deepStrictEqual(JSON.parse(sent[0]), { type: 'hello', n: 1 });
    });

    test('非 OPEN 状态不发送', () => {
        const sent = [];
        const ws = { readyState: 3, send: (d) => sent.push(d) };
        helpers.sendWsJson(ws, { type: 'hello' });
        assert.strictEqual(sent.length, 0);
    });

    test('ws 为空不抛异常', () => {
        helpers.sendWsJson(null, { type: 'hello' });
        helpers.sendWsJson(undefined, { type: 'hello' });
    });
});

describe('isAllowedWsOrigin CSWSH 防护', () => {
    // 临时设置/还原 ALLOWED_ORIGINS
    function withAllowedOrigins(value, fn) {
        const saved = process.env.ALLOWED_ORIGINS;
        if (value === undefined) delete process.env.ALLOWED_ORIGINS;
        else process.env.ALLOWED_ORIGINS = value;
        try {
            return fn();
        } finally {
            if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
            else process.env.ALLOWED_ORIGINS = saved;
        }
    }

    const req = (origin, host) => ({ headers: { ...(origin !== undefined && { origin }), ...(host !== undefined && { host }) } });

    test('无 Origin 的非浏览器客户端直接放行', () => {
        assert.strictEqual(helpers.isAllowedWsOrigin(req(undefined, 'example.com:8443')), true);
    });

    test('Origin 与 Host 完全一致时放行', () => {
        assert.strictEqual(helpers.isAllowedWsOrigin(req('https://example.com:8443', 'example.com:8443')), true);
    });

    test('仅主机名一致（协议/端口不同）也放行，兼容反向代理', () => {
        assert.strictEqual(helpers.isAllowedWsOrigin(req('http://example.com:3000', 'example.com:8443')), true);
    });

    test('跨站 Origin 且未配置白名单时拒绝', () => {
        withAllowedOrigins(undefined, () => {
            assert.strictEqual(helpers.isAllowedWsOrigin(req('https://evil.example', 'example.com:8443')), false);
        });
    });

    test('有 Origin 但无 Host 头时拒绝', () => {
        assert.strictEqual(helpers.isAllowedWsOrigin(req('https://example.com', undefined)), false);
    });

    test('ALLOWED_ORIGINS 白名单（逗号分隔、忽略大小写与空白）放行', () => {
        withAllowedOrigins(' https://Trusted.Example , http://other.io ', () => {
            assert.strictEqual(helpers.isAllowedWsOrigin(req('https://trusted.example', 'example.com:8443')), true);
            assert.strictEqual(helpers.isAllowedWsOrigin(req('http://other.io', 'example.com:8443')), true);
            assert.strictEqual(helpers.isAllowedWsOrigin(req('https://evil.example', 'example.com:8443')), false);
        });
    });

    test('非法 Origin URL 解析失败时拒绝', () => {
        assert.strictEqual(helpers.isAllowedWsOrigin(req('::not-a-url', 'example.com:8443')), false);
    });
});

describe('createStreamTicketRegistry 推流票据', () => {
    test('create 生成 48 位 hex 票据与 UUID 会话号', () => {
        const reg = helpers.createStreamTicketRegistry();
        const { ticket, streamSessionId } = reg.create('c1', 'dev1');
        assert.match(ticket, /^[0-9a-f]{48}$/);
        assert.match(streamSessionId, /^[0-9a-f-]{36}$/);
        assert.strictEqual(reg.size(), 1);
    });

    test('video 与 control 各消费一次，随后票据删除', () => {
        const reg = helpers.createStreamTicketRegistry();
        const { ticket, streamSessionId } = reg.create('c1', 'dev1');

        const video = reg.consume(ticket, 'video');
        assert.ok(video);
        assert.strictEqual(video.serial, 'dev1');
        assert.strictEqual(video.consoleId, 'c1');
        assert.strictEqual(video.streamSessionId, streamSessionId);
        assert.strictEqual(video.videoConsumed, true);

        // 同角色二次消费被拒绝
        assert.strictEqual(reg.consume(ticket, 'video'), null);

        const control = reg.consume(ticket, 'control');
        assert.ok(control);
        assert.strictEqual(control.controlConsumed, true);

        // 双角色都消费后票据删除
        assert.strictEqual(reg.size(), 0);
        assert.strictEqual(reg.consume(ticket, 'control'), null);
    });

    test('未知票据与空票据返回 null', () => {
        const reg = helpers.createStreamTicketRegistry();
        assert.strictEqual(reg.consume('no-such-ticket', 'video'), null);
        assert.strictEqual(reg.consume(null, 'video'), null);
        assert.strictEqual(reg.consume(undefined, 'control'), null);
    });

    test('未知 role 不消费也不报错', () => {
        const reg = helpers.createStreamTicketRegistry();
        const { ticket } = reg.create('c1', 'dev1');
        assert.ok(reg.consume(ticket, 'unknown-role'));
        assert.strictEqual(reg.size(), 1);
    });

    test('恰好 60 秒时仍可消费（有效期判定为严格大于）', () => {
        let nowMs = 1000000;
        const reg = helpers.createStreamTicketRegistry({ now: () => nowMs });
        const { ticket } = reg.create('c1', 'dev1');
        nowMs += 60000; // 恰好等于有效期：仍可用
        assert.ok(reg.consume(ticket, 'video'));
    });

    test('恰好 60 秒整仍有效，超过即失效（严格大于判定）', () => {
        let nowMs = 1000000;
        const reg = helpers.createStreamTicketRegistry({ now: () => nowMs });
        const { ticket } = reg.create('c1', 'dev1');
        nowMs += 60001;
        assert.strictEqual(reg.consume(ticket, 'video'), null);
        assert.strictEqual(reg.size(), 0, '过期票据应被删除');
    });

    test('revokeConsole 只级联删除指定控制台的票据', () => {
        const reg = helpers.createStreamTicketRegistry();
        reg.create('c1', 'd1');
        reg.create('c1', 'd2');
        const keep = reg.create('c2', 'd3');
        reg.revokeConsole('c1');
        assert.strictEqual(reg.size(), 1);
        assert.ok(reg.consume(keep.ticket, 'video'));
    });
});

describe('createRateLimiter 控制命令节流', () => {
    // 起始时间取真实量级（Date.now 语义），避免 0 时刻被 now-0<interval 误判
    test('首次不节流，间隔内再次触发被节流', () => {
        let nowMs = 1000000;
        const throttled = helpers.createRateLimiter({ now: () => nowMs });
        assert.strictEqual(throttled('w1'), false);
        nowMs += 50;
        assert.strictEqual(throttled('w1'), true);
    });

    test('超过最小间隔后放行并刷新时间戳', () => {
        let nowMs = 1000000;
        const throttled = helpers.createRateLimiter({ now: () => nowMs });
        assert.strictEqual(throttled('w1', 100), false); // 首次放行，lastTime=1000000
        nowMs += 99;
        assert.strictEqual(throttled('w1', 100), true);
        nowMs += 1;
        assert.strictEqual(throttled('w1', 100), false); // 100 不小于 100，放行并刷新 lastTime
        nowMs += 99;
        assert.strictEqual(throttled('w1', 100), true);
        nowMs += 1;
        assert.strictEqual(throttled('w1', 100), false);
    });

    test('不同客户端 key 互相独立', () => {
        let nowMs = 1000000;
        const throttled = helpers.createRateLimiter({ now: () => nowMs });
        assert.strictEqual(throttled('w1'), false);
        assert.strictEqual(throttled('w2'), false);
        assert.strictEqual(throttled('w1'), true);
        assert.strictEqual(throttled('w2'), true);
    });
});

describe('getConsolePriority 控制台优先级', () => {
    const t = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-02T00:00:00.000Z';

    test('在线连接恒高于离线连接', () => {
        const online = helpers.getConsolePriority({ ws: { readyState: 1 }, connectedAt: t2 });
        const offline = helpers.getConsolePriority({ ws: { readyState: 3 }, connectedAt: t });
        assert.ok(online > offline);
    });

    test('同状态下越早连接优先级越低（连接时长长者胜出）', () => {
        assert.ok(helpers.getConsolePriority({ ws: { readyState: 1 }, connectedAt: t })
            < helpers.getConsolePriority({ ws: { readyState: 1 }, connectedAt: t2 }));
    });

    test('离线且无时间信息时为 0', () => {
        assert.strictEqual(helpers.getConsolePriority({}), 0);
        assert.strictEqual(helpers.getConsolePriority(null), 0);
    });

    test('非法 connectedAt 字符串按 0 处理', () => {
        assert.strictEqual(helpers.getConsolePriority({ ws: { readyState: 3 }, connectedAt: 'not-a-date' }), 0);
    });
});

// 构造 consoleClients 风格的映射条目
function makeConsole(readyState, connectedAt, devices) {
    return { ws: { readyState }, connectedAt, devices: new Map(Object.entries(devices)) };
}

describe('findDeviceInConsoles 设备查找与 IP 前缀匹配', () => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-02T00:00:00.000Z';

    test('精确 serial 命中并返回所属控制台', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { '9d638992': { model: 'Pixel' } })]
        ]);
        const result = helpers.findDeviceInConsoles(consoles, '9d638992');
        assert.strictEqual(result.consoleId, 'c1');
        assert.strictEqual(result.serial, '9d638992');
        assert.strictEqual(result.device.model, 'Pixel');
    });

    test('优先返回指定控制台上的设备', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { 'devA': { model: 'A1' } })],
            ['c2', makeConsole(1, t2, { 'devA': { model: 'A2' } })]
        ]);
        const result = helpers.findDeviceInConsoles(consoles, 'devA', 'c2');
        assert.strictEqual(result.consoleId, 'c2');
        assert.strictEqual(result.device.model, 'A2');
    });

    test('未指定或指定控制台没有该设备时，在线且更新连接的控制台胜出', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { 'devA': { model: 'A1' } })],
            ['c2', makeConsole(1, t2, { 'devA': { model: 'A2' } })]
        ]);
        assert.strictEqual(helpers.findDeviceInConsoles(consoles, 'devA').device.model, 'A2');

        // 指定的 c3 没有该设备 → 回落到在线控制台
        const consolesWithC3 = new Map([...consoles, ['c3', makeConsole(1, t2, {})]]);
        assert.strictEqual(helpers.findDeviceInConsoles(consolesWithC3, 'devA', 'c3').device.model, 'A2');
    });

    test('离线控制台的设备让位给在线控制台', () => {
        const consoles = new Map([
            ['offline', makeConsole(3, t2, { 'devA': { model: 'offline-dev' } })],
            ['online', makeConsole(1, t1, { 'devA': { model: 'online-dev' } })]
        ]);
        assert.strictEqual(helpers.findDeviceInConsoles(consoles, 'devA').consoleId, 'online');
    });

    test('无线 ADB：纯 IP serial 前缀匹配 IP:port 设备', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { '192.168.0.6:39743': { model: 'Mi11' } })]
        ]);
        const result = helpers.findDeviceInConsoles(consoles, '192.168.0.6');
        assert.strictEqual(result.serial, '192.168.0.6:39743');
        assert.strictEqual(result.device.model, 'Mi11');
    });

    test('非 IP 形式的 serial 不做前缀匹配', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { '9d638992-extra': { model: 'X' } })]
        ]);
        assert.strictEqual(helpers.findDeviceInConsoles(consoles, '9d638992').device, null);
    });

    test('IP 不匹配任何前缀时返回空结果', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { '192.168.0.6:39743': { model: 'Mi11' } })]
        ]);
        assert.deepStrictEqual(
            helpers.findDeviceInConsoles(consoles, '10.0.0.1'),
            { device: null, consoleId: null, serial: null }
        );
    });
});

describe('buildWebDeviceList 设备列表组装', () => {
    const aliases = new Map([['c1:devA', '我的手机']]);
    const groups = new Map([['c1:devA', '家人']]);
    const t1 = '2026-01-01T00:00:00.000Z';

    test('汇总在线控制台设备并生成 deviceId', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { devA: { model: 'Pixel', state: 'device' } })]
        ]);
        const list = helpers.buildWebDeviceList(consoles, new Map(), new Map());
        assert.strictEqual(list.length, 1);
        assert.deepStrictEqual(list[0], {
            id: 'c1:devA', serial: 'devA', model: 'Pixel', state: 'device',
            status: undefined, consoleId: 'c1'
        });
    });

    test('离线控制台的设备不出现在列表中', () => {
        const consoles = new Map([
            ['c1', makeConsole(3, t1, { devA: { model: 'Pixel' } })]
        ]);
        assert.strictEqual(helpers.buildWebDeviceList(consoles, new Map(), new Map()).length, 0);
    });

    test('服务端别名优先于设备自带 customName', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { devA: { model: 'Pixel', customName: '本地名' } })]
        ]);
        assert.strictEqual(
            helpers.buildWebDeviceList(consoles, aliases, new Map())[0].customName, '我的手机'
        );
    });

    test('无服务端别名时回退到设备自带 customName', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { devA: { model: 'Pixel', customName: '本地名' } })]
        ]);
        assert.strictEqual(
            helpers.buildWebDeviceList(consoles, new Map(), new Map())[0].customName, '本地名'
        );
    });

    test('分组：服务端分组优先，设备自带分组兜底，空白分组被忽略', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, {
                devA: { model: 'A', groupName: '  设备自带组  ' },
                devB: { model: 'B', groupName: '   ' }
            })]
        ]);
        const list = helpers.buildWebDeviceList(consoles, new Map(), groups);
        assert.strictEqual(list[0].groupName, '家人');        // 服务端分组胜出且为原始值
        assert.strictEqual(list[1].groupName, undefined);      // 空白分组被过滤
    });

    test('缩略图存在时附带下发', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { devA: { model: 'A', thumbnail: 'base64data' } })]
        ]);
        assert.strictEqual(
            helpers.buildWebDeviceList(consoles, new Map(), new Map())[0].thumbnail, 'base64data'
        );
    });

    test('设备信息缺 serial 字段时回退为映射键', () => {
        const consoles = new Map([
            ['c1', makeConsole(1, t1, { '192.168.0.6:39743': { model: 'A' } })]
        ]);
        assert.strictEqual(
            helpers.buildWebDeviceList(consoles, new Map(), new Map())[0].serial, '192.168.0.6:39743'
        );
    });
});

describe('createStreamTicketRegistry 内存安全（清扫与容量上限）', () => {
    test('create 时惰性清扫从未消费的过期票据', () => {
        let nowMs = 1000000;
        const reg = helpers.createStreamTicketRegistry({ now: () => nowMs });
        reg.create('c1', 'dev1');
        reg.create('c1', 'dev2');
        nowMs += 61000; // 全部过期
        reg.create('c1', 'dev3'); // 触发惰性清扫
        assert.strictEqual(reg.size(), 1, '过期票据应在 create 时被清扫');
    });

    test('达到容量上限后 create 返回 null（调用方须拒绝）', () => {
        const reg = helpers.createStreamTicketRegistry({ maxTickets: 2 });
        assert.ok(reg.create('c1', 'dev1'));
        assert.ok(reg.create('c1', 'dev2'));
        assert.strictEqual(reg.create('c1', 'dev3'), null);
        assert.strictEqual(reg.size(), 2);
    });

    test('清扫后释放容量，可继续创建', () => {
        let nowMs = 1000000;
        const reg = helpers.createStreamTicketRegistry({ now: () => nowMs, maxTickets: 2 });
        reg.create('c1', 'dev1');
        reg.create('c1', 'dev2');
        assert.strictEqual(reg.create('c1', 'dev3'), null);
        nowMs += 61000; // 过期
        const created = reg.create('c1', 'dev3'); // 清扫腾出空间
        assert.ok(created, '清扫后应可继续创建');
        assert.strictEqual(reg.size(), 1);
    });
});

describe('buildWebDeviceList 旧版 serial 别名兼容', () => {
    test('无 deviceId 键时回退匹配纯 serial 键别名', () => {
        const t = Date.now();
        const consoles = new Map([
            ['c1', { ws: { readyState: 1 }, connectedAt: new Date(t).toISOString(), devices: new Map([
                ['02157df2818ba418', { model: 'A', state: 'device', status: 'ready' }]
            ])}]
        ]);
        const aliases = new Map([['02157df2818ba418', '殷紫萍']]);
        const list = helpers.buildWebDeviceList(consoles, aliases, new Map());
        assert.strictEqual(list[0].customName, '殷紫萍');
    });
});
