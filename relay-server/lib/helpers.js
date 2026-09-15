/**
 * server.js 中可独立单测的纯逻辑辅助模块。
 *
 * 只存放不依赖服务器运行时状态的函数与工厂（H.264 解析、环境变量加载、
 * 设备 ID 解析、Origin 校验、推流票据、设备匹配、频率限制等）；
 * 涉及 consoleClients / deviceAliases 等运行时状态的函数一律通过参数注入。
 * 逻辑与 server.js 原实现保持一致，server.js 负责装配。
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');

// ws 库 WebSocket.OPEN 的常量值；此处不 require('ws')，保持模块零运行时依赖
const WS_OPEN = 1;

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

/**
 * 创建日志函数。阈值在创建时固定，与 server.js 原行为一致
 * （进程启动时读取一次 LOG_LEVEL，运行期修改环境变量不影响级别）。
 */
function makeLog(currentLevel) {
    const threshold = LOG_LEVELS[currentLevel];
    return function log(level, ...args) {
        if (LOG_LEVELS[level] <= threshold) {
            const prefix = `[${new Date().toISOString()}] [${level}]`;
            if (level === 'ERROR') console.error(prefix, ...args);
            else if (level === 'WARN') console.warn(prefix, ...args);
            else console.log(prefix, ...args);
        }
    };
}

/**
 * 加载 .env 文件（不覆盖已存在的环境变量）。
 * 文件不存在或格式异常时静默跳过。
 */
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

// 提取 Annex-B H.264 中的 SPS(7) / PPS(8) 参数集数据，用于新观看者初始化
function extractH264ParameterSets(buf) {
    if (!Buffer.isBuffer(buf)) return null;
    let hasSps = false;
    let hasPps = false;
    for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 0 && buf[i + 1] === 0) {
            let nalType = -1;
            if (buf[i + 2] === 1) {
                nalType = buf[i + 3] & 0x1F;
                i += 2;
            } else if (buf[i + 2] === 0 && buf[i + 3] === 1 && i + 4 < buf.length) {
                nalType = buf[i + 4] & 0x1F;
                i += 3;
            }
            if (nalType === 7) hasSps = true;
            if (nalType === 8) hasPps = true;
        }
    }
    if (hasSps || hasPps) {
        return Buffer.from(buf);
    }
    return null;
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
    if (ws && ws.readyState === WS_OPEN) {
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

/**
 * 设备推流票据注册表。票据供 scrcpy 的 video/control 两条 WebSocket
 * 连接各消费一次，超时（默认 60 秒）或双双消费后删除。
 * now/ticketLifetimeMs 可注入，便于单测过期路径。
 */
function createStreamTicketRegistry({ now = Date.now, ticketLifetimeMs = 60000 } = {}) {
    const tickets = new Map();

    function create(consoleId, serial) {
        const ticket = crypto.randomBytes(24).toString('hex');
        const streamSessionId = crypto.randomUUID();
        tickets.set(ticket, {
            consoleId,
            serial,
            streamSessionId,
            createdAt: now(),
            videoConsumed: false,
            controlConsumed: false
        });
        return { ticket, streamSessionId };
    }

    function consume(ticket, role) {
        if (!ticket || !tickets.has(ticket)) return null;
        const entry = tickets.get(ticket);
        if (now() - entry.createdAt > ticketLifetimeMs) {
            tickets.delete(ticket);
            return null;
        }
        if (role === 'video') {
            if (entry.videoConsumed) return null;
            entry.videoConsumed = true;
        } else if (role === 'control') {
            if (entry.controlConsumed) return null;
            entry.controlConsumed = true;
        }
        if (entry.videoConsumed && entry.controlConsumed) {
            tickets.delete(ticket);
        }
        return entry;
    }

    // 级联删除某个控制台属下的所有待处理票据（控制台断开时调用）
    function revokeConsole(consoleId) {
        let removed = 0;
        tickets.forEach((entry, t) => {
            if (entry.consoleId === consoleId) {
                tickets.delete(t);
                removed++;
            }
        });
        return removed;
    }

    return {
        create,
        consume,
        revokeConsole,
        size: () => tickets.size
    };
}

/**
 * Web 控制命令频率限制器（避免频繁按键引发控制台 ADB 进程泛洪）。
 * now 可注入，便于单测时间推进。
 */
function createRateLimiter({ now = Date.now } = {}) {
    const lastTimes = new Map();
    return function isThrottled(key, minIntervalMs = 100) {
        const t = now();
        const lastTime = lastTimes.get(key) || 0;
        if (t - lastTime < minIntervalMs) {
            return true;
        }
        lastTimes.set(key, t);
        return false;
    };
}

// 控制台连接优先级：在线连接恒高于离线，同状态下早连接者优先
function getConsolePriority(consoleClient) {
    const isOpen = !!(consoleClient && consoleClient.ws && consoleClient.ws.readyState === WS_OPEN);
    const connectedAtMs = Date.parse(consoleClient?.connectedAt || '') || 0;
    return (isOpen ? 1e15 : 0) + connectedAtMs;
}

/**
 * 在所有控制台中查找指定 serial 的设备（纯函数版本）。
 * 支持无线 ADB 的 IP 前缀匹配：serial 为纯 IP（如 192.168.0.6）时可匹配
 * 该控制台下所有 `IP:port` 形式的设备；优先返回 preferredConsoleId 上的精确匹配。
 */
function findDeviceInConsoles(consoleClients, serial, preferredConsoleId = null) {
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

/**
 * 汇总所有在线控制台的设备为 Web 端设备列表（纯函数版本）。
 * 合并别名（deviceAliases 优先，其次设备自带 customName）与分组信息。
 */
function buildWebDeviceList(consoleClients, deviceAliases, deviceGroups, log = () => {}) {
    const allDevices = [];

    consoleClients.forEach((consoleClient, consoleId) => {
        if (!consoleClient.ws || consoleClient.ws.readyState !== WS_OPEN) {
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
            } else if (device.customName) {
                deviceInfo.customName = device.customName;
            }

            const groupName = deviceGroups.get(deviceId) || device.groupName;
            if (groupName && String(groupName).trim()) {
                deviceInfo.groupName = String(groupName).trim();
            }

            allDevices.push(deviceInfo);
        });
    });

    return allDevices;
}

module.exports = {
    WS_OPEN,
    LOG_LEVELS,
    makeLog,
    loadEnvFile,
    VIDEO_PROFILES,
    normalizeVideoProfile,
    containsH264Idr,
    extractH264ParameterSets,
    splitDeviceId,
    sendWsJson,
    isAllowedWsOrigin,
    createStreamTicketRegistry,
    createRateLimiter,
    getConsolePriority,
    findDeviceInConsoles,
    buildWebDeviceList
};
