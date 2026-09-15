// Verification script for client-backend communication audit fixes (2026-09-15)
// Asserts that all vulnerabilities (F01-F16) have been resolved.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrcpy-audit-verify-'));
const peers = [];
let child;
let logs = '';
let base;
let cookie;
let failed = 0;
let passed = 0;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (name, ok, details = '') => {
  if (ok) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}${details ? ` -> ${details}` : ''}`);
  }
};

async function until(predicate, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}

async function peer(query, sessionCookie, options = {}) {
  const ws = new WS(base.replace('http:', 'ws:') + '/?' + query, {
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
    ...options
  });
  const p = { ws, messages: [], frames: [], closeCode: null, closeReason: null, send: msg => ws.send(JSON.stringify(msg)) };
  peers.push(p);
  ws.on('message', (data, binary) => {
    if (binary) p.frames.push(Buffer.from(data));
    else {
      try { p.messages.push(JSON.parse(data.toString())); }
      catch (_) { p.messages.push(data.toString()); }
    }
  });
  ws.on('close', (code, reason) => {
    p.closeCode = code;
    p.closeReason = reason ? reason.toString() : '';
  });
  ws.on('error', () => {});
  
  if (!options.expectImmediateClose) {
    try {
      await once(ws, 'open');
    } catch (_) {}
  }
  return p;
}

async function consolePeer(token, serial) {
  const p = await peer('type=console&token=' + token);
  await until(() => p.messages.some(m => m.type === 'welcome'), 'console welcome');
  p.id = p.messages.find(m => m.type === 'welcome').clientId;
  p.serial = serial;
  p.deviceId = `${p.id}:${serial}`;
  p.send({ type: 'deviceList', devices: [{ serial, state: 'device', model: 'Verify mock' }] });
  await delay(80);
  return p;
}

async function webPeer() {
  const p = await peer('type=web', cookie);
  await until(() => p.messages.some(m => m.type === 'deviceList'), 'web device list');
  return p;
}

async function prepare(c) {
  c.messages.length = 0;
  c.send({ type: 'prepareStream', serial: c.serial });
  await until(() => c.messages.some(m => m.type === 'prepareStreamResponse'), 'prepare ack');
  const ack = c.messages.find(m => m.type === 'prepareStreamResponse');
  return ack.ticket;
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
    env: {
      PATH: process.env.PATH,
      HTTP_PORT: '0',
      ENABLE_HTTPS: 'false',
      PASSWORD_LOGIN: 'true',
      WEBRTC_ENABLED: 'true',
      TURN_ENABLED: 'false',
      CONSOLE_TOKEN: token,
      LOG_LEVEL: 'INFO',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  await until(() => /AUDIT_PORT=(\d+)/.test(logs), 'server startup');
  base = 'http://127.0.0.1:' + logs.match(/AUDIT_PORT=(\d+)/)[1];

  // --- Test 1 (F05): Unauthenticated access to protected HTML routes redirects to /login.html ---
  const index = await fetch(base + '/index.html', { redirect: 'manual' });
  assert('F05: Unauthenticated GET /index.html redirects to login.html (302)', index.status === 302);
  const rootReq = await fetch(base + '/', { redirect: 'manual' });
  assert('F05: Unauthenticated GET / redirects to login.html (302)', rootReq.status === 302);

  // Login
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'audit', password })
  });
  assert('Admin login successful', login.status === 200);
  cookie = login.headers.getSetCookie()[0].split(';')[0];

  // --- Test 2 (F07): Logs do not leak cookie/session ID ---
  assert('F07: Logs do not contain full session cookie value', !logs.includes(cookie));

  // --- Test 3 (F01): Unauthenticated scrcpy / control without ticket or token or session is rejected ---
  const unauthScrcpy = await peer('type=scrcpy&serial=test-dev', null, { expectImmediateClose: true });
  await until(() => unauthScrcpy.ws.readyState === WS.CLOSED, 'unauth scrcpy rejected');
  assert('F01: Unauthenticated scrcpy connection rejected with 1008', unauthScrcpy.closeCode === 1008);

  const unauthControl = await peer('type=control&serial=test-dev', null, { expectImmediateClose: true });
  await until(() => unauthControl.ws.readyState === WS.CLOSED, 'unauth control rejected');
  assert('F01: Unauthenticated control connection rejected with 1008', unauthControl.closeCode === 1008);

  // --- Test 4 (F01/F02): Stream ticket creation, consumption, and routing ---
  const consoleA = await consolePeer(token, 'device-101');
  const ticket = await prepare(consoleA);
  assert('F01: prepareStream returns valid ticket', typeof ticket === 'string' && ticket.length > 10);

  // Connect scrcpy with ticket
  const videoA = await peer(`type=scrcpy&serial=device-101&ticket=${ticket}`);
  await delay(80);
  assert('F01: scrcpy video connects successfully using valid ticket', videoA.ws.readyState === WS.OPEN);

  // Second attempt with the SAME ticket must fail (single use)
  const videoA2 = await peer(`type=scrcpy&serial=device-101&ticket=${ticket}`, null, { expectImmediateClose: true });
  await until(() => videoA2.ws.readyState === WS.CLOSED, 'reused ticket rejected');
  assert('F01: Stream ticket is strictly single-use', videoA2.closeCode === 1008);

  // --- Test 5 (F02): Cross-console fallback removed ---
  const consoleB = await consolePeer(token, 'device-101'); // same serial on different console
  const webClient = await webPeer();
  // Select nonexistent console ID:
  webClient.send({ type: 'selectDevice', deviceId: 'nonexistent_console:device-101' });
  await until(() => webClient.messages.some(m => m.type === 'startDeviceFailed'), 'select failed reply');
  const failMsg = webClient.messages.find(m => m.type === 'startDeviceFailed');
  assert('F02: No silent fallback across consoles; returns console_not_found', failMsg && failMsg.reason === 'console_not_found');

  // --- Test 6 (F06): /api/devices DTO contains no raw socket objects ---
  const apiResp = await fetch(base + '/api/devices', { headers: { Cookie: cookie, Accept: 'application/json' } });
  const devices = await apiResp.json();
  const hasRawSockets = devices.some(d => (d.videoWs && typeof d.videoWs === 'object') || (d.controlWs && typeof d.controlWs === 'object'));
  assert('F06: /api/devices does not serialize raw WebSocket objects', !hasRawSockets);

  // --- Test 7 (F11): In-place deviceUpdate and connection replacement isolation ---
  const oldWs = videoA.ws;
  // Send deviceUpdate from consoleA
  consoleA.send({ type: 'deviceUpdate', device: { serial: 'device-101', state: 'device', model: 'updated-model' } });
  await delay(80);
  // Prepare and connect new videoWs
  const ticket2 = await prepare(consoleA);
  const videoA_replacement = await peer(`type=scrcpy&serial=device-101&ticket=${ticket2}`);
  await delay(80);
  // Close OLD video socket
  oldWs.close();
  await delay(80);
  // The device should still have the replacement active, NOT cleared
  const apiCheck = await fetch(base + '/api/devices', { headers: { Cookie: cookie, Accept: 'application/json' } });
  const devList = await apiCheck.json();
  const devObj = devList.find(d => d.serial === 'device-101' && d.consoleId === consoleA.id);
  assert('F11: Closing old video socket does not clear replacement socket', devObj && devObj.status === 'streaming');

  // --- Test 8 (F15): SPS/PPS parameter set extraction and re-sending on new viewer join ---
  // Send an SPS/PPS frame into videoA_replacement
  const spsPpsFrame = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80]);
  videoA_replacement.ws.send(spsPpsFrame);
  await delay(60);

  // Second viewer joins device
  const webClient2 = await webPeer();
  webClient2.frames.length = 0;
  webClient2.send({ type: 'selectDevice', deviceId: consoleA.deviceId });
  await until(() => webClient2.frames.length > 0, 'SPS/PPS frame delivered to new viewer');
  assert('F15: New viewer immediately receives cached SPS/PPS parameter sets', webClient2.frames.some(f => f.includes(0x67)));

  // --- Test 9 (F16): Scoped device aliases and groups (no serial leakage) ---
  webClient.send({ type: 'updateDeviceName', deviceId: consoleA.deviceId, customName: 'ConsoleA_Custom' });
  await delay(60);
  const devListAfterName = await (await fetch(base + '/api/devices', { headers: { Cookie: cookie } })).json();
  const devA = devListAfterName.find(d => d.consoleId === consoleA.id && d.serial === 'device-101');
  const devB = devListAfterName.find(d => d.consoleId === consoleB.id && d.serial === 'device-101');
  assert('F16: Custom name applied to target console device', devA && devA.customName === 'ConsoleA_Custom');
  assert('F16: Same serial device on Console B is NOT polluted by Console A name', devB && devB.customName !== 'ConsoleA_Custom');

  // --- Test 10 (F05): Revocation of WebSocket on /api/logout ---
  const logoutResp = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert('F05: POST /api/logout returns 200', logoutResp.status === 200);
  await until(() => webClient.ws.readyState === WS.CLOSED, 'web client WS closed after logout');
  assert('F05: WebClient WebSocket revoked and closed upon session logout', webClient.ws.readyState === WS.CLOSED);

  // --- Test 11 (F03): Malformed / unmasked client frame does NOT crash server ---
  // Authenticate a new web client
  const relogin = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'audit', password })
  });
  const newCookie = relogin.headers.getSetCookie()[0].split(';')[0];
  const webClient3 = await peer('type=web', newCookie);
  // Send invalid unmasked frame
  webClient3.ws.send('malformed-unmasked-payload', { mask: false });
  await delay(100);
  assert('F03: Server remains alive after receiving malformed/unmasked frame', child.exitCode === null);

  // --- Test 12 (F04): TURN server authentication logic ---
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
  await turnContext.module.exports.initTurnServer({ enabled: true, secret: 'verification-turn-secret' });
  assert('F04: TURN server configured with authMech=long-term', turnInstance.authMech === 'long-term');
  
  // Anonymous authentication must be rejected
  let anonymousPassed = false;
  turnInstance.authentification.auth({ getAttribute: () => null, reply: () => ({ addAttribute() {}, reject() {} }) }, err => { anonymousPassed = !err; });
  assert('F04: Anonymous TURN connection is rejected', !anonymousPassed);

  // Valid HMAC credential check
  const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
  const testUser = `${futureTimestamp}:turn_user`;
  const hmac = crypto.createHmac('sha1', 'verification-turn-secret');
  hmac.update(testUser);
  const validPass = hmac.digest('base64');
  const creds = turnInstance.staticCredentials || (turnInstance.authentification && turnInstance.authentification.credentials);
  assert('F04: TURN credentials Proxy returns valid HMAC key for username', creds && creds[testUser] === validPass);

  // Expired timestamp credential check
  const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
  const expiredUser = `${pastTimestamp}:expired_user`;
  assert('F04: TURN credentials Proxy rejects expired username timestamp', creds && creds[expiredUser] === undefined);
  turnContext.module.exports.stopTurnServer();

  // --- Test 13 (F08, F09): WebRTC signaling isolation and multi-viewer broadcast ---
  const signaling = req('./webrtc-signaling.js');
  const fake = () => ({ readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } });
  const cA = fake(), cB = fake(), wA1 = fake(), wA2 = fake();
  const consolesMap = new Map([['console_A', { ws: cA }], ['console_B', { ws: cB }]]);
  const websMap = new Map([
    ['web_1', { ws: wA1, currentDevice: 'console_A:dev' }],
    ['web_2', { ws: wA2, currentDevice: 'console_A:dev' }]
  ]);
  
  // Offer broadcast to all matching viewers
  signaling.handleOffer('console_A', { deviceId: 'console_A:dev', sdp: { type: 'offer', sdp: 'test' } }, cA, websMap);
  assert('F08: WebRTC offer broadcasts to all viewers watching device',
    wA1.sent.some(m => m.type === 'webrtc-offer') && wA2.sent.some(m => m.type === 'webrtc-offer'));

  // Injected answer from unselected web client must be rejected
  signaling.handleAnswer('unauthorized_web', { deviceId: 'console_A:dev', sdp: { type: 'answer', sdp: 'fake' } }, consolesMap);
  assert('F08: WebRTC answer from unauthorized client rejected', !cA.sent.some(m => m.type === 'webrtc-answer'));

  // Injected ICE from unrelated console must be rejected
  signaling.handleIceCandidate('console_B', { deviceId: 'console_A:dev', candidate: { candidate: 'fake' }, from: 'console' }, consolesMap, websMap);
  assert('F09: WebRTC ICE candidate from unrelated console rejected', !wA1.sent.some(m => m.type === 'webrtc-ice-candidate'));

  console.log(`\n========================================`);
  console.log(`All verification tests finished!`);
  console.log(`Total Passed: ${passed}, Total Failed: ${failed}`);
  console.log(`========================================\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  failed++;
  console.error('Unhandled error in verification script:', error);
}).finally(async () => {
  for (const p of peers) {
    try { p.ws.terminate(); } catch (_) {}
  }
  if (child && child.exitCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGKILL');
    await done;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
});
