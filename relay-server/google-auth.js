/**
 * Google OAuth 2.0 登录辅助模块
 *
 * 移植自 photo 项目（~/Documents/photo/src/server/auth/google.ts），
 * 管理员邮箱白名单机制与其保持一致（ADMIN_EMAIL，区分大小写归一后严格比对）。
 * 登录成功后由 server.js 写入现有 express-session，复用既有鉴权体系。
 */

'use strict';

const crypto = require('crypto');

// 默认使用 Google 官方端点；保留环境变量覆盖能力用于本地联调/测试
const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = process.env.GOOGLE_USERINFO_URL || 'https://www.googleapis.com/oauth2/v2/userinfo';
// 走中继（覆盖 GOOGLE_*_URL）时必带的共享密钥，见 photo 项目的 scrcpy-auth-relay 端点
const SCRCPY_RELAY_KEY = process.env.SCRCPY_RELAY_KEY || '';

/**
 * 解析 Google OAuth 配置。密钥与白名单绝不给默认值：
 * 未配置时 isGoogleOAuthConfigured() 返回 false，登录入口直接拒绝（fail closed）。
 */
function getGoogleOAuthConfig() {
    return {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        // 显式指定回调地址（生产环境有反向代理/自定义域名时建议配置），
        // 留空则按当前请求的 origin 动态推导
        redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
        adminEmail: (process.env.ADMIN_EMAIL || '').toLowerCase()
    };
}

function isGoogleOAuthConfigured() {
    const cfg = getGoogleOAuthConfig();
    return Boolean(cfg.clientId && cfg.clientSecret && cfg.adminEmail);
}

function base64Url(buf) {
    return buf.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/** CSRF 防护用随机 state */
function generateState() {
    return crypto.randomBytes(16).toString('hex');
}

/** PKCE (S256) 授权码校验对，防止授权码被截获重放 */
function generatePkcePair() {
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function getGoogleAuthUrl(params) {
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
}

/** 常数时间字符串比较（state 校验用），长度不等直接返回 false */
function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

async function exchangeGoogleCode(params) {
    const tokenParams = {
        code: params.code,
        client_id: params.clientId,
        client_secret: params.clientSecret,
        redirect_uri: params.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: params.codeVerifier
    };
    // 覆盖 GOOGLE_TOKEN_URL（中继模式）时以 JSON 提交以穿透 Astro CSRF，
    // worker 端会转回 form-urlencoded 再请求 Google；直连 Google 时保持官方表单格式
    const usingRelay = !!process.env.GOOGLE_TOKEN_URL;

    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: usingRelay
            ? { 'Content-Type': 'application/json', 'X-Relay-Key': SCRCPY_RELAY_KEY }
            : { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: usingRelay ? JSON.stringify(tokenParams) : new URLSearchParams(tokenParams).toString()
    });

    if (!res.ok) {
        // Google 的完整响应只在服务端记录，抛给上层的错误信息必须可安全展示
        const errorText = await res.text();
        console.error(`[Google登录] token 兑换失败 (${res.status}): ${errorText}`);
        throw new Error(`Google token exchange failed (${res.status})`);
    }

    return res.json();
}

async function getGoogleUserInfo(accessToken) {
    const res = await fetch(GOOGLE_USERINFO_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(SCRCPY_RELAY_KEY && { 'X-Relay-Key': SCRCPY_RELAY_KEY })
        }
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`[Google登录] userinfo 请求失败 (${res.status}): ${errorText}`);
        throw new Error(`Google userinfo request failed (${res.status})`);
    }

    return res.json();
}

module.exports = {
    getGoogleOAuthConfig,
    isGoogleOAuthConfigured,
    generateState,
    generatePkcePair,
    getGoogleAuthUrl,
    timingSafeEqualStr,
    exchangeGoogleCode,
    getGoogleUserInfo
};
