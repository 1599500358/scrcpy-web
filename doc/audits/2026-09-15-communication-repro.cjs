// Local audit evidence: runs a temporary copy with synthetic accounts/devices.
// No production connections, credentials, device commands, or repository config writes.
// OBSERVED confirms the named behavior; it does not mean the behavior is safe.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const relay = path.join(root, 'relay-server');
const req = createRequire(path.join(relay, 'package.json'));
const WS = req('ws');
const bcrypt = req('bcryptjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrcpy-communication-audit-'));
const peers = [];
let child;
let logs = '';
let base;
let cookie;
let failed = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, ok) => {
  console.log(`${ok ? 'OBSERVED' : 'NOT OBSERVED'}: ${name}`);
  if (!ok) failed++;
};
async function until(predicate, description, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}
async function peer(query, sessionCookie) {
  const ws = new WS(base.replace('http:', 'ws:') + '/?' + query,
    sessionCookie ? { headers: { Cookie: sessionCookie } } : {});
  const p = { ws, messages: [], frames: [], send: msg => ws.send(JSON.stringify(msg)) };
  peers.push(p);
  ws.on('message', (data, binary) => {
    if (binary) p.frames.push(Buffer.from(data));
    else p.messages.push(JSON.parse(data.toString()));
  });
  ws.on('error', () => {});
  await once(ws, 'open');
  return p;
}
async function consolePeer(token, serial) {
  const p = await peer('type=console&token=' + token);
  await until(() => p.messages.some(m => m.type === 'welcome'), 'console welcome');
  p.id = p.messages.find(m => m.type === 'welcome').clientId;
  p.serial = serial;
  p.deviceId = `${p.id}:${serial}`;
  p.send({ type: 'deviceList', devices: [{ serial, state: 'device', model: 'Audit mock' }] });
  await delay(80);
  return p;
}
async function webPeer() {
  const p = await peer('type=web', cookie);
  await until(() => p.messages.some(m => m.type === 'deviceList'), 'web device list');
  return p;
}
async function select(p, c) {
  p.send({ type: 'selectDevice', deviceId: c.deviceId });
  await delay(80);
}
async function prepare(c) {
  c.messages.length = 0;
  c.send({ type: 'prepareStream', serial: c.serial });
  await until(() => c.messages.some(m => m.type === 'prepareStreamResponse'), 'prepare ack');
}
async function close(p) {
  if (p.ws.readyState === WS.CLOSED) return;
  const done = once(p.ws, 'close');
  p.ws.close();
  await done;
  await delay(50);
}
async function main() {
  for (const file of ['server.js', 'auth-manager.js', 'google-auth.js', 'webrtc-signaling.js', 'turn-server.js']) {
    fs.copyFileSync(path.join(relay, file), path.join(tmp, file));
  }
  fs.symlinkSync(path.join(relay, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  fs.symlinkSync(path.join(relay, 'public'), path.join(tmp, 'public'), 'dir');
  const password = crypto.randomBytes(20).toString('hex');
  const token = crypto.randomBytes(20).toString('hex');
  fs.writeFileSync(path.join(tmp, 'auth-config.json'), JSON.stringify({
    users: [{ username: 'audit', passwordHash: await bcrypt.hash(password, 4), role: 'admin' }],
    sessionConfig: { secret: crypto.randomBytes(32).toString('hex'), cookie: { maxAge: 60000 } },
    security: {}
  }));
  // Bind only loopback, using a kernel-assigned port; keep application handlers unchanged.
  fs.writeFileSync(path.join(tmp, 'bootstrap.cjs'), `
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(port, cb) {
      return listen.call(this, 0, '127.0.0.1', () => {
        console.log('AUDIT_PORT=' + this.address().port);
        if (cb) cb();
      });
    };
    require('./server.js');
  `);
  child = spawn(process.execPath, ['bootstrap.cjs'], {
    cwd: tmp,
    env: { PATH: process.env.PATH, HTTP_PORT: '0', ENABLE_HTTPS: 'false',
      PASSWORD_LOGIN: 'true', WEBRTC_ENABLED: 'true', TURN_ENABLED: 'false',
      CONSOLE_TOKEN: token, LOG_LEVEL: 'INFO', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  await until(() => /AUDIT_PORT=(\d+)/.test(logs), 'isolated server startup');
  base = 'http://127.0.0.1:' + logs.match(/AUDIT_PORT=(\d+)/)[1];
  const index = await fetch(base + '/index.html', { redirect: 'manual' });
  check('Unauthenticated index.html returns 200 (UI only)', index.status === 200);
  const login = await fetch(base + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'audit', password }) });
  if (login.status !== 200) throw new Error('Synthetic login failed');
  cookie = login.headers.getSetCookie()[0].split(';')[0];

  const unauthConsole = await peer('type=console');
  await until(() => unauthConsole.ws.readyState === WS.CLOSED, 'missing console token rejected');
  check('Regression: configured CONSOLE_TOKEN rejects unauthenticated console',
    !unauthConsole.messages.some(m => m.type === 'welcome'));

  const a = await consolePeer(token, 'emulator-5554');
  const wa = await webPeer();
  await select(wa, a);
  const b = await consolePeer(token, 'emulator-5554');
  const wb = await webPeer();
  await select(wb, b);
  await prepare(a);
  const video1 = await peer('type=scrcpy&serial=emulator-5554'); // No token or session.
  const marker = Buffer.from([0, 0, 0, 1, 0x65, 0x41, 0x55, 0x44]);
  video1.ws.send(marker);
  await until(() => wb.frames.length > 0, 'misrouted synthetic frame');
  check('A prepared stream is consumed without credentials and delivered to B viewer',
    wa.frames.length === 0 && wb.frames.some(f => f.equals(marker)));

  const control1 = await peer('type=control&serial=emulator-5554');
  wb.send({ type: 'touch', action: 'down', x: 7, y: 8, width: 100, height: 200 });
  await until(() => control1.messages.some(m => m.action === 'touch'), 'unauthenticated control capture');
  check('Unauthenticated control connection receives another client touch commands', true);

  const api = await fetch(base + '/api/devices', { headers: { Cookie: cookie, Accept: 'application/json' } });
  const apiBody = api.status === 200 ? await api.json() : null;
  check('Device API serializes internal videoWs/controlWs fields',
    Array.isArray(apiBody) && apiBody.some(d => d.videoWs && d.controlWs));

  const control2 = await peer('type=control&serial=emulator-5554');
  await delay(60);
  await close(control1);
  b.messages.length = 0;
  wb.send({ type: 'touch', action: 'up', x: 7, y: 8, width: 100, height: 200 });
  await until(() => b.messages.some(m => m.action === 'touch'), 'control fallback after old close');
  check('Closing old control socket clears replacement; touch falls back to console',
    control2.messages.length === 0);

  const wb2 = await webPeer();
  await select(wb2, b);
  b.messages.length = 0;
  wb2.send({ type: 'stopDevice' });
  await delay(120);
  check('Regression: one viewer stops without stopping remaining viewer stream',
    !b.messages.some(m => m.type === 'stopDevice'));

  await prepare(b);
  const video2 = await peer('type=scrcpy&serial=emulator-5554');
  await delay(60);
  await close(video1);
  b.messages.length = 0;
  await select(wb2, b);
  check('Closing old video socket clears replacement; next viewer triggers duplicate start',
    b.messages.some(m => m.type === 'startDevice'));

  const c = await consolePeer(token, 'snapshot-device');
  const wc = await webPeer();
  await select(wc, c);
  await prepare(c);
  const videoC = await peer('type=scrcpy&serial=snapshot-device');
  await delay(60);
  c.send({ type: 'deviceUpdate', device: { serial: c.serial, state: 'device', model: 'updated' } });
  await delay(80);
  await close(videoC);
  const fresh = await webPeer();
  const snapshot = fresh.messages.find(m => m.type === 'deviceList').devices.find(d => d.id === c.deviceId);
  check('deviceUpdate replaces live object; video close leaves device status streaming',
    snapshot && snapshot.status === 'streaming');

  const logout = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
  const user = await fetch(base + '/api/user', { headers: { Cookie: cookie, Accept: 'application/json' } });
  b.messages.length = 0;
  wb.send({ type: 'touch', action: 'down', x: 9, y: 9, width: 100, height: 200 });
  await until(() => b.messages.some(m => m.action === 'touch'), 'post-logout command');
  check('HTTP logout revokes session but existing WebSocket retains device control',
    logout.status === 200 && user.status === 401 && b.messages.some(m => m.x === 9));
  check('INFO logs contain complete session cookie (value intentionally not printed)', logs.includes(cookie));

  // Exercise the actual signaling module with in-memory socket fixtures, no network peers.
  const signaling = req('./webrtc-signaling.js');
  const fake = () => ({ readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } });
  const ca = fake(), cb = fake(), w1 = fake(), w2 = fake();
  const consoles = new Map([['console_A', { ws: ca }], ['console_B', { ws: cb }]]);
  const webs = new Map([['web_1', { ws: w1, currentDevice: 'console_A:dev' }],
    ['web_2', { ws: w2, currentDevice: 'console_A:dev' }]]);
  const savedLog = console.log;
  try {
    console.log = () => {};
    signaling.handleOffer('console_A', { deviceId: 'console_A:dev', sdp: { type: 'offer', sdp: 'synthetic' } }, ca, webs);
    signaling.handleAnswer('unselected_web', { deviceId: 'console_A:dev', sdp: { type: 'answer', sdp: 'injected' } }, consoles);
    signaling.handleIceCandidate('console_B', { deviceId: 'console_A:dev', candidate: { candidate: 'injected' }, from: 'console' }, consoles, webs);
  } finally { console.log = savedLog; }
  check('WebRTC offer reaches only last matching viewer',
    w1.sent.length === 0 && w2.sent.some(m => m.type === 'webrtc-offer'));
  check('WebRTC accepts answer from an unselected web client',
    ca.sent.some(m => m.type === 'webrtc-answer' && m.sdp.sdp === 'injected'));
  check('WebRTC accepts ICE from an unrelated console',
    w2.sent.some(m => m.type === 'webrtc-ice-candidate' && m.candidate.candidate === 'injected'));
  signaling.pendingConnections.clear();

  // Execute the real TURN setup and real dependency constructor, suppressing socket start.
  const vm = require('node:vm');
  const RealTurn = req('node-turn');
  let turnInstance;
  class OfflineTurn extends RealTurn {
    constructor(config) { super(config); turnInstance = this; }
    start() {}
    stop() {}
  }
  const turnContext = {
    module: { exports: {} }, console: { log() {}, error() {} },
    process: { env: {} },
    require: name => name === 'node-turn' ? OfflineTurn : req(name)
  };
  vm.runInNewContext(fs.readFileSync(path.join(relay, 'turn-server.js'), 'utf8'), turnContext);
  await turnContext.module.exports.initTurnServer({ enabled: true, secret: 'synthetic-audit-secret' });
  let anonymousAuthAccepted = false;
  turnInstance.authentification.auth({ reply: () => ({}) }, err => { anonymousAuthAccepted = !err; });
  check('TURN config defaults to authMech=none and accepts credential-free authentication',
    turnInstance.authMech === 'none' && anonymousAuthAccepted);
  turnContext.module.exports.stopTurnServer();

  // Final isolated-process check: malformed framing on an unauthenticated control socket.
  const malformed = await peer('type=control&serial=snapshot-device');
  await delay(60);
  malformed.ws.send('audit-invalid-unmasked-frame', { mask: false });
  await until(() => child.exitCode !== null, 'server exits on unhandled WebSocket error');
  check('Unauthenticated malformed control frame terminates entire relay process',
    child.exitCode !== 0 && logs.includes('Unhandled') && logs.includes('MASK'));
  void video2;
}
main().catch(error => { failed++; console.error(error.message); }).finally(async () => {
  for (const p of peers) p.ws.terminate();
  if (child && child.exitCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGKILL');
    await done;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
});
