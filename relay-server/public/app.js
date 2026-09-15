// 使用 WebCodecs 实现 H.264 解码
// 支持 WebSocket 和 WebRTC DataChannel 两种传输方式

let ws = null;
let currentDevice = null;
let canvas = null;
let ctx = null;

// 视频解码器
let videoDecoder = null;
let isDecoderReady = false;
let waitingForKeyframe = false;
let lastDecoderConfig = null; // 最近一次成功的解码器配置（过载恢复时重新 configure 用）

// H.264 流缓冲
let nalBuffer = [];

// 性能统计
let frameCount = 0;
let lastFrameTime = 0;
let lastStatsTime = 0;
let bytesReceived = 0;

// ========== 链路诊断（方案 4.1 可观测性） ==========
const diag = {
    connectionType: '-',      // WebRTC 直连 / WebRTC TURN / WebSocket 中继
    iceRtt: null,             // 选中 candidate pair 的 currentRoundTripTime
    localCandidateType: '-',
    remoteCandidateType: '-',
    selectedProtocol: '-',
    decodeQueueSize: 0,       // 最近一次采样的解码队列长度
    decodeQueueSamples: [],   // 最近 N 秒的队列采样
    consoleBuffered: null,    // 控制台 DataChannel 发送水位（字节）
    consoleFramesSent: null,
    consoleFramesDropped: null,
    firstFrameMs: null,       // 选择设备到首帧绘制的耗时
    drawMs: null,             // 最近一次 drawImage 耗时
    fps: 0,
    kbpsIn: 0,
    profile: '-',             // 实际生效画质档位
    profileArgs: '',
    keyframeMode: '-',
};
let currentEpoch = 0;         // 每次切换设备/重建连接递增，用于拒绝旧流回调
let pendingFirstFrameStart = 0;
let keyframeFallbackTimer = null;
let decoderReconfigFallbackTimer = null;
let decoderOverloadSamples = 0;
let lastKeyframeRequestAt = 0;

// 画质档位定义（与控制台白名单一致）
const VIDEO_PROFILES = [
    { id: 'interactive', label: '交互优先 (1280/4M/60fps)' },
    { id: 'sharp', label: '清晰优先 (1920/6M/60fps)' },
    { id: 'weaknet', label: '弱网 (1024/2M/30fps)' },
    { id: 'original', label: '原有配置 (不限尺寸/8M)' },
];
let selectedProfile = localStorage.getItem('videoProfile');
if (!VIDEO_PROFILES.some(p => p.id === selectedProfile)) {
    selectedProfile = 'interactive';
}

// ========== WebRTC 相关 ==========
let peerConnection = null;
let dataChannel = null;
let webrtcEnabled = false;
let rtcConfig = null;
let useWebRTC = false; // 是否使用 WebRTC 模式
let pendingCandidates = []; // 缓存的 ICE candidates
const WEBRTC_CHUNK_MAGIC = 0xA5;
const WEBRTC_CHUNK_HEADER_SIZE = 6;
let assemblingFrameId = null;
let assemblingChunks = [];
let assemblingSize = 0;
let wsReconnectTimer = null;
let authRedirecting = false;
const MOBILE_LAYOUT_BREAKPOINT = 900;

function isAuthFailureMessage(text) {
    if (!text) return false;
    const normalized = String(text).toLowerCase();
    return normalized.includes('未授权') ||
        normalized.includes('unauthorized') ||
        normalized.includes('forbidden') ||
        normalized.includes('auth');
}

function redirectToLogin(reason) {
    if (authRedirecting) {
        return;
    }
    authRedirecting = true;
    console.warn('[AUTH] 会话失效，跳转登录页:', reason || 'unknown');
    updateStatus(false, '会话已失效，正在跳转登录...');

    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }

    if (ws) {
        try {
            ws.onclose = null;
            ws.close();
        } catch (e) {
            console.warn('[AUTH] 关闭WS失败(可忽略):', e);
        }
    }
    ws = null;

    closeWebRTC(true);
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    window.location.href = '/login';
}

async function checkSessionExpired() {
    try {
        const response = await fetch('/api/user', { cache: 'no-store' });
        return response.status === 401 || response.status === 403;
    } catch (e) {
        return false;
    }
}

function isMobileLayout() {
    return window.innerWidth <= MOBILE_LAYOUT_BREAKPOINT;
}

function openMobileDevicePanel() {
    if (!isMobileLayout()) {
        return;
    }
    document.body.classList.add('mobile-sidebar-open');
}

function closeMobileDevicePanel() {
    document.body.classList.remove('mobile-sidebar-open');
}

function initMobileUI() {
    const openBtn = document.getElementById('openDevicePanelBtn');
    const closeBtn = document.getElementById('closeDevicePanelBtn');
    const backdrop = document.getElementById('mobileDrawerBackdrop');
    const videoContainer = document.getElementById('videoContainer');

    if (openBtn) {
        openBtn.onclick = openMobileDevicePanel;
    }
    if (closeBtn) {
        closeBtn.onclick = closeMobileDevicePanel;
    }
    if (backdrop) {
        backdrop.onclick = closeMobileDevicePanel;
    }
    if (videoContainer) {
        videoContainer.addEventListener('click', () => {
            if (isMobileLayout()) {
                closeMobileDevicePanel();
            }
        });
    }

    window.addEventListener('resize', () => {
        if (!isMobileLayout()) {
            closeMobileDevicePanel();
        }
    });
}

// 初始化
window.onload = async function() {
    console.log('[INIT] 页面加载完成，初始化组件...');

    // 获取 canvas 元素
    canvas = document.getElementById('videoCanvas');
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    // 初始化解码器
    initDecoder();

    // 获取 WebRTC 配置
    await fetchWebRTCConfig();

    // 连接 WebSocket
    connectWebSocket();

    // 绑定登出按钮
    document.getElementById('logoutBtn').onclick = logout;
    const username = localStorage.getItem('username');
    if (username) {
        const usernameEl = document.getElementById('username');
        if (usernameEl) {
            usernameEl.textContent = username;
        }
    }

    // 初始化触摸事件
    initTouchEvents();
    initMobileUI();
    initVideoProfileSelector();

    console.log('[INIT] 初始化完成, WebRTC:', webrtcEnabled ? '启用' : '禁用');
};

// ========== 画质档位选择（切换需重启视频，控制台白名单校验） ==========
function initVideoProfileSelector() {
    const select = document.getElementById('videoProfileSelect');
    if (!select) {
        return;
    }

    VIDEO_PROFILES.forEach((p) => {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = p.label;
        select.appendChild(option);
    });
    select.value = selectedProfile;
    diag.profile = selectedProfile;

    select.onchange = () => {
        const newProfile = select.value;
        if (newProfile === selectedProfile) {
            return;
        }
        const previous = selectedProfile;
        selectedProfile = newProfile;
        localStorage.setItem('videoProfile', newProfile);

        if (!currentDevice) {
            diag.profile = newProfile;
            return;
        }
        if (!confirm('切换画质需要重启视频推流（画面会短暂中断），是否继续？')) {
            selectedProfile = previous;
            select.value = previous;
            return;
        }
        restartCurrentDeviceWithProfile();
    };
}

// 切换画质需要重启视频：停止当前推流，随后按新档位重新选择设备。
// 切换期间画面会中断，不做无缝切换伪装
function restartCurrentDeviceWithProfile() {
    const deviceId = currentDevice;
    console.log(`[DEVICE] 按档位 ${selectedProfile} 重启推流: ${deviceId}`);

    clearDecoderRecoveryTimers();
    currentEpoch++;
    closeWebRTC(true);
    resetWebRTCAssembler();
    if (videoDecoder && videoDecoder.state !== 'unconfigured') {
        videoDecoder.reset();
    }
    nalBuffer = [];
    waitingForKeyframe = false;
    lastDecoderConfig = null;
    diag.profile = selectedProfile;
    diag.profileArgs = '';
    document.getElementById('loading').style.display = 'flex';

    ws.send(JSON.stringify({ type: 'stopDevice', deviceId }));
    currentDevice = null;

    setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            selectDevice(deviceId);
        }
    }, 1000);
}

// ========== WebRTC 函数 ==========

// 获取 WebRTC 配置
async function fetchWebRTCConfig() {
    try {
        const response = await fetch('/api/webrtc-config');
        if (response.ok) {
            const config = await response.json();
            webrtcEnabled = config.enabled;
            if (webrtcEnabled) {
                rtcConfig = {
                    iceServers: config.iceServers
                };
                console.log('[WebRTC] 配置获取成功, ICE Servers:', config.iceServers.length);
            }
        } else if (response.status === 401 || response.status === 403) {
            redirectToLogin(`fetch /api/webrtc-config ${response.status}`);
            return;
        } else {
            console.log('[WebRTC] 获取配置失败，将使用 WebSocket 模式');
        }
    } catch (e) {
        console.error('[WebRTC] 获取配置出错:', e);
    }
}

// 创建 WebRTC 连接（Answerer 模式）
async function createWebRTCConnection(deviceId) {
    if (!rtcConfig) {
        console.error('[WebRTC] 配置未初始化');
        return null;
    }

    console.log('[WebRTC] 创建 PeerConnection...');
    const myEpoch = currentEpoch;

    try {
        peerConnection = new RTCPeerConnection(rtcConfig);

        // 监听 DataChannel
        peerConnection.ondatachannel = (event) => {
            console.log('[WebRTC] 收到 DataChannel:', event.channel.label);
            dataChannel = event.channel;
            setupDataChannel(dataChannel, deviceId, myEpoch);
        };

        // 监听 ICE Candidate
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('[WebRTC] 发送 ICE candidate');
                ws.send(JSON.stringify({
                    type: 'webrtc-ice-candidate',
                    deviceId: deviceId,
                    candidate: event.candidate,
                    from: 'web'
                }));
            }
        };

        // 监听连接状态
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            console.log('[WebRTC] 连接状态:', state);

            if (state === 'connected') {
                // 连接建立不区分直连/TURN，实际路径由 getStats 采样的诊断面板显示
                console.log('[WebRTC] ✅ 连接建立（直连/TURN 由诊断面板显示）');
                useWebRTC = true;
                ws.send(JSON.stringify({
                    type: 'webrtc-connected',
                    deviceId: deviceId
                }));
            } else if (state === 'disconnected' || state === 'failed') {
                console.log('[WebRTC] ❌ 连接断开或失败');
                useWebRTC = false;
                ws.send(JSON.stringify({
                    type: 'webrtc-disconnected',
                    deviceId: deviceId
                }));
                // 回退到 WebSocket 模式
                if (state === 'failed') {
                    console.log('[WebRTC] 回退到 WebSocket 模式');
                }
            }
        };

        // 监听 ICE 连接状态
        peerConnection.oniceconnectionstatechange = () => {
            console.log('[WebRTC] ICE 状态:', peerConnection.iceConnectionState);
        };

        return peerConnection;
    } catch (e) {
        console.error('[WebRTC] 创建 PeerConnection 失败:', e);
        return null;
    }
}

// 设置 DataChannel
function setupDataChannel(channel, deviceId, myEpoch) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
        console.log('[WebRTC] DataChannel 已打开');
        if (myEpoch !== undefined && myEpoch !== currentEpoch) {
            console.log('[WebRTC] 忽略旧 epoch 的 DataChannel 打开事件');
            try { channel.close(); } catch (e) { /* ignore */ }
            return;
        }
        useWebRTC = true;

        // 隐藏加载提示
        document.getElementById('loading').style.display = 'none';
    };

    channel.onclose = () => {
        console.log('[WebRTC] DataChannel 已关闭');
        useWebRTC = false;
    };

    channel.onerror = (error) => {
        console.error('[WebRTC] DataChannel 错误:', error);
        useWebRTC = false;
    };

    channel.onmessage = (event) => {
        if (myEpoch !== undefined && myEpoch !== currentEpoch) {
            return; // 旧 epoch 残留数据，直接丢弃
        }
        if (typeof event.data === 'string') {
            handleConsoleMetrics(event.data);
            return;
        }
        if (event.data instanceof ArrayBuffer) {
            // 更新统计
            bytesReceived += event.data.byteLength;

            // 兼容分片/非分片两种格式
            handleIncomingVideoData(new Uint8Array(event.data));
        }
    };
}

// 处理控制台侧指标上报（诊断面板数据源）
function handleConsoleMetrics(text) {
    try {
        const msg = JSON.parse(text);
        if (msg.type !== 'consoleMetrics') {
            return;
        }
        diag.consoleBuffered = typeof msg.bufferedAmount === 'number' ? msg.bufferedAmount : null;
        diag.consoleFramesSent = typeof msg.framesSent === 'number' ? msg.framesSent : null;
        diag.consoleFramesDropped = typeof msg.framesDropped === 'number' ? msg.framesDropped : null;
    } catch (e) {
        // 非指标文本消息，忽略
    }
}

function handleIncomingVideoData(buffer) {
    if (buffer.length >= WEBRTC_CHUNK_HEADER_SIZE && buffer[0] === WEBRTC_CHUNK_MAGIC) {
        const flags = buffer[1];
        const frameId = (
            buffer[2] |
            (buffer[3] << 8) |
            (buffer[4] << 16) |
            (buffer[5] << 24)
        ) >>> 0;
        const isStart = (flags & 0x01) !== 0;
        const isEnd = (flags & 0x02) !== 0;
        const payload = buffer.subarray(WEBRTC_CHUNK_HEADER_SIZE);

        if (isStart) {
            assemblingFrameId = frameId;
            assemblingChunks = [];
            assemblingSize = 0;
        }

        if (assemblingFrameId !== frameId) {
            return;
        }

        if (payload.length > 0) {
            const copy = new Uint8Array(payload.length);
            copy.set(payload);
            assemblingChunks.push(copy);
            assemblingSize += copy.length;
        }

        if (isEnd) {
            let frameData;
            if (assemblingChunks.length === 1) {
                frameData = assemblingChunks[0];
            } else {
                frameData = new Uint8Array(assemblingSize);
                let offset = 0;
                for (const part of assemblingChunks) {
                    frameData.set(part, offset);
                    offset += part.length;
                }
            }

            decodeH264Data(frameData);
            resetWebRTCAssembler();
        }
        return;
    }

    // 兼容旧版未分片发送格式
    decodeH264Data(buffer);
}

// 处理 WebRTC Offer
async function handleWebRTCOffer(deviceId, sdp, consoleId) {
    console.log('[WebRTC] 收到 Offer, deviceId:', deviceId, 'consoleId:', consoleId);
    console.log('[WebRTC] 当前选择的设备:', currentDevice);
    console.log('[WebRTC] SDP 类型:', sdp.type);

    if (!peerConnection) {
        console.log('[WebRTC] peerConnection 不存在，创建新连接...');
        await createWebRTCConnection(deviceId);
    } else {
        console.log('[WebRTC] peerConnection 已存在');
    }

    if (!peerConnection) {
        console.error('[WebRTC] 无法创建 PeerConnection');
        return;
    }

    try {
        // 设置远程描述
        console.log('[WebRTC] 设置远程描述...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        console.log('[WebRTC] 已设置远程描述');

        // 发送缓存的 ICE candidates
        console.log('[WebRTC] 添加缓存的 ICE candidates:', pendingCandidates.length);
        for (const candidate of pendingCandidates) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingCandidates = [];

        // 创建 Answer
        console.log('[WebRTC] 创建 Answer...');
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log('[WebRTC] 已创建 Answer');

        // 发送 Answer 给控制台
        ws.send(JSON.stringify({
            type: 'webrtc-answer',
            deviceId: deviceId,
            sdp: answer
        }));
        console.log('[WebRTC] Answer 已发送');

    } catch (e) {
        console.error('[WebRTC] 处理 Offer 失败:', e);
    }
}

// 处理 ICE Candidate（来自控制台）
async function handleWebRTCIceCandidate(deviceId, candidate) {
    console.log('[WebRTC] 收到 ICE candidate');

    if (peerConnection && peerConnection.remoteDescription) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('[WebRTC] 添加 ICE candidate 失败:', e);
        }
    } else {
        // 缓存，等 remoteDescription 设置后再添加
        pendingCandidates.push(candidate);
    }
}

// 关闭 WebRTC 连接
function closeWebRTC(silent = false) {
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    useWebRTC = false;
    pendingCandidates = [];
    resetWebRTCAssembler();
    if (!silent) {
        console.log('[WebRTC] 连接已关闭');
    }
}

function resetWebRTCAssembler() {
    assemblingFrameId = null;
    assemblingChunks = [];
    assemblingSize = 0;
}

// ========== 链路诊断与过载恢复 ==========

// 通过 getStats 识别实际连接路径（直连/TURN）与探测 RTT。
// 注意：PeerConnection connected 只代表链路建立，类型必须以选中的 candidate pair 为准
async function pollConnectionStats() {
    if (!peerConnection || peerConnection.connectionState !== 'connected') {
        if (!useWebRTC) {
            diag.connectionType = useWsRelay() ? 'WebSocket 中继' : '-';
        }
        return;
    }

    try {
        const stats = await peerConnection.getStats();
        let pair = null;
        stats.forEach((report) => {
            if (report.type === 'candidate-pair' &&
                (report.selected === true || report.nominated === true ||
                 (report.state === 'succeeded' && report.selected === undefined && report.nominated === undefined && !pair))) {
                if (!pair || report.selected || report.nominated) {
                    pair = report;
                }
            }
        });

        if (pair) {
            const local = stats.get(pair.localCandidateId);
            const remote = stats.get(pair.remoteCandidateId);
            diag.iceRtt = typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null;
            diag.selectedProtocol = pair.protocol || '-';
            diag.localCandidateType = local ? local.candidateType : '-';
            diag.remoteCandidateType = remote ? remote.candidateType : '-';

            const isRelay = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
            diag.connectionType = isRelay ? 'WebRTC TURN' : 'WebRTC 直连';
        }
    } catch (e) {
        // 统计获取失败不影响主流程
    }
}

function useWsRelay() {
    return !useWebRTC && ws && ws.readyState === WebSocket.OPEN && currentDevice;
}

// 每秒采样：解码队列、统计面板刷新、状态文本更新
function diagTick() {
    if (videoDecoder && videoDecoder.state === 'configured') {
        diag.decodeQueueSize = videoDecoder.decodeQueueSize;

        // 解码压力早期信号：连续多个采样 ≥ 4 个 access unit 视为持续过载（方案 8.2）
        diag.decodeQueueSamples.push(videoDecoder.decodeQueueSize);
        if (diag.decodeQueueSamples.length > 5) {
            diag.decodeQueueSamples.shift();
        }
        const samples = diag.decodeQueueSamples;
        if (samples.length >= 3 && samples.slice(-3).every(q => q >= 4)) {
            decoderOverloadSamples++;
        } else {
            decoderOverloadSamples = 0;
        }
        if (decoderOverloadSamples >= 3) {
            decoderOverloadSamples = 0;
            recoverFromDecoderOverload();
        }
    } else {
        diag.decodeQueueSize = 0;
    }

    pollConnectionStats();
    updateDiagnosticsPanel();
    updateStatusTextWithConnectionType();
}

// 解码持续过载：重置解码器并请求新 IDR，从关键帧恢复（不使用 flush 追赶实时画面）。
// reset 后不立即用旧配置 configure：优先等待流内 SPS/PPS 重建（覆盖过载期间
// 旋转/改分辨率的场景）；编码端不重发带内配置时由 2 秒兜底定时器使用旧配置
function recoverFromDecoderOverload() {
    if (!isDecoderReady || !videoDecoder || videoDecoder.state === 'closed') {
        return;
    }
    console.warn('[DECODER] 检测到持续解码积压，重置解码器并请求新关键帧');
    videoDecoder.reset();
    nalBuffer = [];
    waitingForKeyframe = true;
    diag.decodeQueueSamples = [];

    if (decoderReconfigFallbackTimer) {
        clearTimeout(decoderReconfigFallbackTimer);
    }
    decoderReconfigFallbackTimer = setTimeout(() => {
        decoderReconfigFallbackTimer = null;
        if (videoDecoder && videoDecoder.state === 'unconfigured' && lastDecoderConfig) {
            console.warn('[DECODER] 流内未出现新 SPS/PPS，使用最近一次配置兜底');
            try {
                videoDecoder.configure(lastDecoderConfig);
            } catch (e) {
                console.error('[DECODER] 兜底配置失败:', e);
            }
        }
    }, 2000);

    requestKeyframeWithFallback('overload');
}

// 清理解码器恢复相关的定时器（切设备/断开时调用）
function clearDecoderRecoveryTimers() {
    if (keyframeFallbackTimer) {
        clearTimeout(keyframeFallbackTimer);
        keyframeFallbackTimer = null;
    }
    if (decoderReconfigFallbackTimer) {
        clearTimeout(decoderReconfigFallbackTimer);
        decoderReconfigFallbackTimer = null;
    }
}

// 请求关键帧：优先轻量同步帧；2 秒内无新帧则回退旧版 resetVideo 语义
function requestKeyframeWithFallback(reason) {
    const now = Date.now();
    if (now - lastKeyframeRequestAt < 500) {
        return; // 合并重复请求
    }
    lastKeyframeRequestAt = now;

    const framesBefore = frameCount;
    if (isP2PControlReady()) {
        dataChannel.send(JSON.stringify({ type: 'control', action: 'requestSyncFrame' }));
    }

    if (keyframeFallbackTimer) {
        clearTimeout(keyframeFallbackTimer);
    }
    keyframeFallbackTimer = setTimeout(() => {
        keyframeFallbackTimer = null;
        if (frameCount === framesBefore && isP2PControlReady()) {
            console.warn('[H264] 同步帧请求未见效果，回退 resetVideo (reason=%s)', reason);
            dataChannel.send(JSON.stringify({ type: 'control', action: 'resetVideo' }));
        }
    }, 2000);
}

// 后台标签页恢复：检查帧龄，必要时请求新关键帧，避免回放后台期间的旧帧
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentDevice) {
        const stale = !lastFrameTime || (performance.now() - lastFrameTime > 2000);
        if (stale) {
            console.log('[VIDEO] 页面恢复且画面过期，请求新关键帧');
            requestKeyframeWithFallback('visibility');
        }
    }
});

function updateStatusTextWithConnectionType() {
    // 普通界面仅显示连接类型与状态；详细指标在诊断面板
    if (currentDevice && diag.connectionType && diag.connectionType !== '-') {
        const statusText = document.getElementById('statusText');
        if (statusText && !statusText.textContent.includes(diag.connectionType)) {
            statusText.textContent = `已连接 (${diag.connectionType})`;
        }
    }
}

function updateDiagnosticsPanel() {
    const content = document.getElementById('diagContent');
    if (!content || document.getElementById('diagPanel')?.open !== true) {
        return;
    }

    const fmtBytes = (v) => v === null || v === undefined ? '-' :
        (v > 1024 ? `${(v / 1024).toFixed(1)} KB` : `${v} B`);
    const fmtMs = (v) => v === null || v === undefined ? '-' : `${v.toFixed(1)} ms`;

    const rttText = diag.iceRtt === null ? '-' : `${diag.iceRtt.toFixed(1)} ms`;
    const q = diag.decodeQueueSamples.slice(-5).join(',') || '-';
    content.innerHTML = `
        <div>连接路径: ${diag.connectionType} (${diag.localCandidateType}→${diag.remoteCandidateType} ${diag.selectedProtocol})</div>
        <div>ICE RTT: ${rttText}</div>
        <div>码率: ${diag.kbpsIn.toFixed(0)} kbps | FPS: ${diag.fps.toFixed(1)} (目标 ${currentProfileTargetFps()})</div>
        <div>解码队列: ${diag.decodeQueueSize} (近5s: ${q})</div>
        <div>控制台发送水位: ${fmtBytes(diag.consoleBuffered)}</div>
        <div>控制台帧 发送/丢弃: ${diag.consoleFramesSent ?? '-'} / ${diag.consoleFramesDropped ?? '-'}</div>
        <div>绘制耗时: ${fmtMs(diag.drawMs)} | 首帧: ${diag.firstFrameMs === null ? '-' : `${(diag.firstFrameMs / 1000).toFixed(1)} s`}</div>
        <div>画质档位: ${diag.profile} ${diag.profileArgs || ''}</div>
        <div>关键帧模式: ${diag.keyframeMode}</div>
    `;
}

function currentProfileTargetFps() {
    switch (diag.profile) {
        case 'interactive': return 60;
        case 'sharp': return 60;
        case 'weaknet': return 30;
        case 'original': return '-';
        default: return '-';
    }
}

setInterval(diagTick, 1000);

// 初始化视频解码器
function initDecoder() {
    if (!('VideoDecoder' in window)) {
        console.error('[DECODER] ❌ 浏览器不支持 WebCodecs API');
        showError('浏览器不支持 WebCodecs，请使用 Chrome/Edge 94+');
        return;
    }
    
    console.log('[DECODER] ✅ WebCodecs API 可用');
    
    videoDecoder = new VideoDecoder({
        output: onFrameDecoded,
        error: (e) => {
            console.error('[DECODER] ❌ 解码错误:', e.message);
            showError(`视频解码错误: ${e.message}`);
        }
    });
    
    isDecoderReady = true;
    console.log('[DECODER] 解码器已创建，等待配置...');
}

// 配置解码器
function configureDecoder(codecString, description) {
    if (!videoDecoder || videoDecoder.state === 'closed') {
        console.error('[DECODER] 解码器未初始化或已关闭');
        return false;
    }
    
    // 如果解码器已配置且参数相同，跳过
    if (videoDecoder.state === 'configured') {
        console.log('[DECODER] 检测到配置变化，重置解码器...');
        videoDecoder.reset();
        nalBuffer = []; // 清空 NAL 缓冲
    }
    
    const config = {
        codec: codecString,
        optimizeForLatency: true,
    };
    
    if (description) {
        config.description = description;
    }
    
    try {
        console.log(`[DECODER] 配置解码器: codec=${codecString}, description=${description ? description.length + ' bytes' : 'none'}`);
        videoDecoder.configure(config);
        console.log('[DECODER] ✅ 解码器配置成功');
        waitingForKeyframe = true; // 等待关键帧
        lastDecoderConfig = config; // 过载恢复时重新 configure
        diag.decodeQueueSamples = [];
        return true;
    } catch (e) {
        console.error('[DECODER] ❌ 配置失败:', e);
        showError(`解码器配置失败: ${e.message}`);
        return false;
    }
}

// 帧解码完成回调
function onFrameDecoded(frame) {
    frameCount++;

    // 设置 canvas 尺寸
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        adjustCanvasSize();
        console.log(`[DECODER] 视频分辨率: ${frame.displayWidth}x${frame.displayHeight}`);
    }

    // 绘制帧到 canvas
    const drawStart = performance.now();
    ctx.drawImage(frame, 0, 0);
    frame.close();
    diag.drawMs = performance.now() - drawStart;

    if (pendingFirstFrameStart > 0) {
        diag.firstFrameMs = performance.now() - pendingFirstFrameStart;
        pendingFirstFrameStart = 0;
        console.log(`[STATS] 首帧耗时: ${(diag.firstFrameMs / 1000).toFixed(2)} s`);
    }

    // 计算帧率
    const now = performance.now();
    if (lastFrameTime > 0) {
        const delta = now - lastFrameTime;
        const fps = 1000 / delta;

        // 每秒更新一次统计
        if (now - lastStatsTime > 1000) {
            console.log(`[STATS] FPS: ${fps.toFixed(1)}, 帧数: ${frameCount}, 接收: ${(bytesReceived / 1024).toFixed(1)} KB/s`);
            diag.fps = fps;
            diag.kbpsIn = (bytesReceived * 8) / 1000;
            bytesReceived = 0;
            lastStatsTime = now;
        }
    }
    lastFrameTime = now;

    // 隐藏加载提示
    document.getElementById('loading').style.display = 'none';
}

// 调整 canvas 显示尺寸
function adjustCanvasSize() {
    const container = document.getElementById('videoContainer');
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    const videoWidth = canvas.width;
    const videoHeight = canvas.height;
    
    if (!videoWidth || !videoHeight) return;
    
    const containerRatio = containerWidth / containerHeight;
    const videoRatio = videoWidth / videoHeight;
    
    let displayWidth, displayHeight;
    
    if (containerRatio > videoRatio) {
        displayHeight = containerHeight;
        displayWidth = displayHeight * videoRatio;
    } else {
        displayWidth = containerWidth;
        displayHeight = displayWidth / videoRatio;
    }
    
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';
}

// 连接 WebSocket
function connectWebSocket() {
    if (authRedirecting) {
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}?type=web`; // 添加 type 参数
    
    console.log('[WS] 正在连接:', wsUrl);
    updateStatus(false, '正在连接...');
    
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
        console.log('[WS] ✅ WebSocket 连接成功');
        updateStatus(true, '已连接');
        
        console.log('[WS] 等待设备列表...');
    };
    
    ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            handleTextMessage(event.data);
        } else {
            handleBinaryMessage(event.data);
        }
    };
    
    ws.onerror = (error) => {
        console.error('[WS] ❌ WebSocket 错误:', error);
        updateStatus(false, '连接错误');
    };
    
    ws.onclose = async (event) => {
        const reason = event.reason || '';

        if (event.code === 1008 || isAuthFailureMessage(reason)) {
            redirectToLogin(`ws_close code=${event.code}, reason=${reason || 'empty'}`);
            return;
        }

        // 某些代理/网关下会表现为 1006，这里补一次会话探测
        if (event.code === 1006) {
            const expired = await checkSessionExpired();
            if (expired) {
                redirectToLogin('ws_close code=1006 + /api/user unauthorized');
                return;
            }
        }

        console.log(`[WS] 连接已关闭(code=${event.code}, reason=${reason || 'none'})，3秒后重连...`);
        updateStatus(false, '连接断开');
        wsReconnectTimer = setTimeout(connectWebSocket, 3000);
    };
}

// 处理文本消息
function handleTextMessage(data) {
    try {
        const message = JSON.parse(data);
        
        // 添加调试信息
        console.log('[WS] 接收到WebSocket消息:', message);
        
        switch (message.type) {
            case 'deviceList':
                updateDeviceList(message.devices);
                break;
            case 'deviceUpdate':
                updateSingleDevice(message.device);
                break;
            case 'error':
                if (isAuthFailureMessage(message.message)) {
                    redirectToLogin(`ws_error_message: ${message.message}`);
                    return;
                }
                showError(message.message);
                break;
            case 'startDeviceFailed':
                showError(message.message || '设备启动失败');
                console.error('[DEVICE] 启动失败:', message);
                break;

            case 'streamingStarted':
                // 控制台上报的实际生效档位与参数
                if (message.profile) {
                    diag.profile = message.profile;
                    diag.profileArgs = message.args || '';
                    diag.keyframeMode = message.keyframeMode || '-';
                    console.log(`[DEVICE] 推流已启动: 档位=${message.profile}, 参数=${message.args || '(默认)'}`);
                }
                break;

            // ========== WebRTC 信令消息 ==========
            case 'webrtc-offer':
                // 收到控制台的 WebRTC Offer
                handleWebRTCOffer(message.deviceId, message.sdp, message.consoleId);
                break;

            case 'webrtc-ice-candidate':
                // 收到 ICE Candidate
                handleWebRTCIceCandidate(message.deviceId, message.candidate);
                break;

            case 'webrtc-waiting':
                // 控制台等待连接（暂无 Web 客户端）
                console.log('[WebRTC] 控制台等待中:', message.message);
                break;

            default:
                console.log('[WS] 未知消息类型:', message.type);
        }
    } catch (e) {
        console.error('[WS] JSON 解析失败:', e);
        // 添加原始数据的调试信息
        console.log('[WS] 原始数据:', data);
    }
}

// 处理二进制消息（视频数据）- WebSocket 模式
function handleBinaryMessage(data) {
    // 如果正在使用 WebRTC，忽略 WebSocket 二进制数据
    if (useWebRTC) {
        return;
    }

    if (!isDecoderReady || !videoDecoder) {
        return;
    }

    const buffer = new Uint8Array(data);
    bytesReceived += buffer.length;

    // 直接解码 H.264 Annex-B 格式数据
    decodeH264Data(buffer);
}

// 解码 H.264 数据
function decodeH264Data(data) {
    // 检查 NAL 起始码
    if (data.length < 4) return;

    // 提取 NAL 单元
    const nalUnits = extractNalUnits(data);

    for (const nal of nalUnits) {
        const nalType = nal.data[0] & 0x1F;

        // SPS (7) 和 PPS (8) 用于配置解码器
        if (nalType === 7 || nalType === 8) {
            console.log(`[H264] 收到 ${nalType === 7 ? 'SPS' : 'PPS'}, 大小: ${nal.data.length}`);
            nalBuffer.push(nal);

            // SPS/PPS 齐备后重建配置：unconfigured 直接配置；
            // 已配置时与现行配置逐字节比较，仅在参数变化（旋转/改分辨率）时重配置。
            // 编码器仅在重置时重发带内 SPS/PPS，因此不能无限追加历史数组
            if (nalBuffer.length >= 2) {
                const config = buildDecoderConfig(nalBuffer);
                nalBuffer = [];
                if (config) {
                    if (videoDecoder.state === 'unconfigured') {
                        configureDecoder(config.codec, config.description);
                    } else if (videoDecoder.state === 'configured' &&
                               !isSameDecoderConfig(config, lastDecoderConfig)) {
                        console.log('[H264] 检测到编码参数变化，重置并重新配置解码器');
                        configureDecoder(config.codec, config.description);
                    }
                }
            }
        }
        // IDR 帧 (5) 或 P 帧 (1)
        else if (nalType === 5 || nalType === 1) {
            if (videoDecoder.state === 'configured') {
                const isKeyFrame = nalType === 5;

                if (waitingForKeyframe && !isKeyFrame) {
                    console.log('[H264] 丢弃非关键帧，等待关键帧...');
                    continue;
                }

                if (waitingForKeyframe && isKeyFrame) {
                    console.log('[H264] 收到首个关键帧，开始解码');
                    waitingForKeyframe = false;
                }

                try {
                    const chunk = new EncodedVideoChunk({
                        type: isKeyFrame ? 'key' : 'delta',
                        timestamp: performance.now() * 1000,
                        data: nalToAVCC(nal.data)
                    });

                    videoDecoder.decode(chunk);
                } catch (e) {
                    console.error('[DECODER] 解码失败:', e);
                }
            }
        }
    }
}

// 比较两份解码器配置是否一致（codec 串 + avcC description 字节）
function isSameDecoderConfig(a, b) {
    if (!a || !b || a.codec !== b.codec) {
        return false;
    }
    const da = a.description;
    const db = b.description;
    if (!da || !db || da.length !== db.length) {
        return false;
    }
    for (let i = 0; i < da.length; i++) {
        if (da[i] !== db[i]) {
            return false;
        }
    }
    return true;
}

// 提取 NAL 单元
function extractNalUnits(data) {
    const units = [];
    let i = 0;
    
    while (i < data.length - 3) {
        let startCodeLength = 0;
        
        if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 0 && data[i+3] === 1) {
            startCodeLength = 4;
        } else if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) {
            startCodeLength = 3;
        } else {
            i++;
            continue;
        }
        
        const start = i + startCodeLength;
        let end = start + 1;
        
        // 查找下一个起始码
        while (end < data.length - 3) {
            if ((data[end] === 0 && data[end+1] === 0 && data[end+2] === 0 && data[end+3] === 1) ||
                (data[end] === 0 && data[end+1] === 0 && data[end+2] === 1)) {
                break;
            }
            end++;
        }
        
        if (end >= data.length - 3) end = data.length;
        
        units.push({
            startCodeLength,
            data: data.slice(start, end)
        });
        
        i = end;
    }
    
    return units;
}

// 构建解码器配置
function buildDecoderConfig(nalUnits) {
    let sps = null, pps = null;
    
    for (const nal of nalUnits) {
        const type = nal.data[0] & 0x1F;
        if (type === 7) sps = nal.data;
        if (type === 8) pps = nal.data;
    }
    
    if (!sps || !pps) return null;
    
    // 从 SPS 提取 Profile/Level
    const profile = sps[1];
    const constraints = sps[2];
    const level = sps[3];
    
    const codecString = `avc1.${profile.toString(16).padStart(2, '0')}${constraints.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
    
    // 构建 avcC description
    const description = buildAVCCDescription(sps, pps);
    
    console.log(`[H264] Codec: ${codecString}, Description: ${description.length} bytes`);
    
    return { codec: codecString, description };
}

// 构建 avcC 格式的 description
function buildAVCCDescription(sps, pps) {
    const size = 11 + sps.length + pps.length;
    const data = new Uint8Array(size);
    let offset = 0;
    
    data[offset++] = 1; // version
    data[offset++] = sps[1]; // profile
    data[offset++] = sps[2]; // constraints
    data[offset++] = sps[3]; // level
    data[offset++] = 0xFF; // 6 bits reserved + 2 bits nal size length - 1
    data[offset++] = 0xE1; // 3 bits reserved + 5 bits number of sps
    
    // SPS
    data[offset++] = (sps.length >> 8) & 0xFF;
    data[offset++] = sps.length & 0xFF;
    data.set(sps, offset);
    offset += sps.length;
    
    // PPS count
    data[offset++] = 1;
    
    // PPS
    data[offset++] = (pps.length >> 8) & 0xFF;
    data[offset++] = pps.length & 0xFF;
    data.set(pps, offset);
    
    return data;
}

// 将 NAL 单元转换为 AVCC 格式
function nalToAVCC(nal) {
    const avcc = new Uint8Array(4 + nal.length);
    avcc[0] = (nal.length >> 24) & 0xFF;
    avcc[1] = (nal.length >> 16) & 0xFF;
    avcc[2] = (nal.length >> 8) & 0xFF;
    avcc[3] = nal.length & 0xFF;
    avcc.set(nal, 4);
    return avcc;
}

function normalizeGroupName(groupName) {
    const normalized = typeof groupName === 'string' ? groupName.trim() : '';
    return normalized || '未分组';
}

function compareGroupName(a, b) {
    if (a === b) return 0;
    if (a === '未分组') return 1;
    if (b === '未分组') return -1;
    return a.localeCompare(b, 'zh-CN');
}

function createDeviceListItem(device) {
    const li = document.createElement('li');
    li.className = 'device-item';
    li.dataset.deviceId = `${device.consoleId}:${device.serial}`;
    const displayName = (
        (typeof device.customName === 'string' && device.customName.trim()) ||
        (typeof device.model === 'string' && device.model.trim()) ||
        device.serial
    );
    
    const thumbnailContainer = document.createElement('div');
    thumbnailContainer.className = 'device-thumbnail';
    
    const thumbnail = document.createElement('img');
    thumbnail.style.cssText = 'max-width: 100%; max-height: 100%; object-fit: contain;';
    if (device.thumbnail) {
        thumbnail.src = `data:image/jpeg;base64,${device.thumbnail}`;
    } else {
        thumbnail.style.display = 'none';
        const placeholder = document.createElement('span');
        placeholder.className = 'thumbnail-placeholder';
        placeholder.textContent = '无预览';
        placeholder.style.cssText = 'color: #666; font-size: 12px;';
        thumbnailContainer.appendChild(placeholder);
    }
    thumbnail.alt = displayName;
    thumbnailContainer.appendChild(thumbnail);
    
    const details = document.createElement('div');
    details.className = 'device-details';

    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = displayName;
    name.title = displayName;

    const actionWrap = document.createElement('div');
    actionWrap.className = 'device-actions';
    
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-name-btn';
    editBtn.textContent = '修改';
    editBtn.onclick = (e) => {
        e.stopPropagation();
        openEditNameModal(device);
    };

    const groupBtn = document.createElement('button');
    groupBtn.className = 'edit-name-btn group-btn';
    groupBtn.textContent = '分组';
    groupBtn.onclick = (e) => {
        e.stopPropagation();
        openEditGroupModal(device);
    };

    actionWrap.appendChild(editBtn);
    actionWrap.appendChild(groupBtn);

    // 第一行只显示设备名，第二行显示操作按钮
    details.appendChild(name);
    details.appendChild(actionWrap);
    
    li.onclick = (evt) => selectDevice(`${device.consoleId}:${device.serial}`, evt);
    
    if (currentDevice === `${device.consoleId}:${device.serial}`) {
        li.classList.add('selected');
    }
    
    li.appendChild(thumbnailContainer);
    li.appendChild(details);
    return li;
}

// 更新设备列表（按分组展示）
function updateDeviceList(devices) {
    const deviceList = document.getElementById('deviceList');
    const statsInfo = document.getElementById('statsInfo');
    const mobileOpenBtn = document.getElementById('openDevicePanelBtn');
    
    console.log('[DEVICE] 接收到设备列表:', devices);
    
    if (!devices || devices.length === 0) {
        deviceList.innerHTML = '<li class="no-device">等待控制台连接...</li>';
        statsInfo.textContent = '控制台: 0 | 设备: 0';
        if (mobileOpenBtn) {
            mobileOpenBtn.textContent = '📱 设备 (0)';
        }
        return;
    }
    
    const consoles = new Set(devices.map(d => d.consoleId));
    statsInfo.textContent = `控制台: ${consoles.size} | 设备: ${devices.length}`;
    if (mobileOpenBtn) {
        mobileOpenBtn.textContent = `📱 设备 (${devices.length})`;
    }
    
    const groupedMap = new Map();
    devices.forEach((device) => {
        const groupName = normalizeGroupName(device.groupName);
        if (!groupedMap.has(groupName)) {
            groupedMap.set(groupName, []);
        }
        groupedMap.get(groupName).push(device);
    });

    const sortedGroupNames = Array.from(groupedMap.keys()).sort(compareGroupName);
    deviceList.innerHTML = '';

    sortedGroupNames.forEach((groupName) => {
        const devicesInGroup = groupedMap.get(groupName) || [];
        devicesInGroup.sort((a, b) => (a.customName || a.model || '').localeCompare((b.customName || b.model || ''), 'zh-CN'));

        const groupBlock = document.createElement('li');
        groupBlock.className = 'device-group-block';

        const groupTitle = document.createElement('div');
        groupTitle.className = 'device-group-title';
        groupTitle.innerHTML = `<span>${groupName}</span><span class="device-group-count">${devicesInGroup.length} 台</span>`;

        const groupList = document.createElement('ul');
        groupList.className = 'device-group-list';
        devicesInGroup.forEach((device) => {
            groupList.appendChild(createDeviceListItem(device));
        });

        groupBlock.appendChild(groupTitle);
        groupBlock.appendChild(groupList);
        deviceList.appendChild(groupBlock);
    });
}

// 更新单个设备信息
function updateSingleDevice(device) {
    const deviceList = document.getElementById('deviceList');
    const li = deviceList.querySelector(`li[data-device-id="${device.consoleId}:${device.serial}"]`);
    
    if (!li) return;
    
    // 更新缩略图
    const thumbnailContainer = li.querySelector('.device-thumbnail');
    const thumbnail = thumbnailContainer ? thumbnailContainer.querySelector('img') : null;
    if (thumbnailContainer && thumbnail) {
        // 先移除旧的占位符（避免多次累积）
        const oldPlaceholder = thumbnailContainer.querySelector('.thumbnail-placeholder');
        if (oldPlaceholder) {
            oldPlaceholder.remove();
        }

        if (device.thumbnail) {
            console.log(`[DEVICE] 设备 ${device.serial} 有缩略图数据，长度: ${device.thumbnail.length}`);
            thumbnail.src = `data:image/jpeg;base64,${device.thumbnail}`;
            thumbnail.style.display = 'block';
        } else {
            console.log(`[DEVICE] 设备 ${device.serial} 没有缩略图数据`);
            thumbnail.style.display = 'none';
            const placeholder = document.createElement('span');
            placeholder.className = 'thumbnail-placeholder';
            placeholder.textContent = '无预览';
            placeholder.style.cssText = 'color: #666; font-size: 12px;';
            thumbnailContainer.appendChild(placeholder);
        }
    }
    
    // 按需求：deviceUpdate 仅更新设备状态/缩略图，不更新设备名称
}

// 选择设备
function selectDevice(deviceId, evt) {
    console.log('[DEVICE] 选择设备:', deviceId);
    currentDevice = deviceId;
    closeMobileDevicePanel();

    // 递增 epoch：旧 DataChannel/WebSocket 回调的数据将被拒绝
    currentEpoch++;
    clearDecoderRecoveryTimers();

    // 重置解码器
    if (videoDecoder && videoDecoder.state !== 'unconfigured') {
        videoDecoder.reset();
    }
    nalBuffer = [];
    waitingForKeyframe = false;
    lastDecoderConfig = null;
    decoderOverloadSamples = 0;

    // 关闭之前的 WebRTC 连接（静默模式，因为可能立即建立新连接）
    closeWebRTC(true);
    resetWebRTCAssembler();

    // 更新 UI
    document.querySelectorAll('.device-item').forEach(item => {
        item.classList.remove('selected');
    });
    if (evt && evt.target) {
        const item = evt.target.closest('.device-item');
        if (item) item.classList.add('selected');
    }

    // 通知服务器选择设备（控制台会发送 WebRTC Offer）
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'selectDevice',
            deviceId: deviceId,
            profile: selectedProfile, // 画质档位（控制台侧白名单校验）
            webrtc: webrtcEnabled // 告诉服务器我们支持 WebRTC
        }));
    }

    // 显示视频区域
    document.getElementById('noDevice').style.display = 'none';
    document.getElementById('videoCanvas').style.display = 'block';
    document.getElementById('loading').style.display = 'flex';

    // 重置统计与诊断
    frameCount = 0;
    lastFrameTime = 0;
    lastStatsTime = performance.now();
    bytesReceived = 0;
    pendingFirstFrameStart = performance.now();
    diag.firstFrameMs = null;
    diag.drawMs = null;
    diag.fps = 0;
    diag.kbpsIn = 0;
    diag.connectionType = '-';
    diag.iceRtt = null;
    diag.consoleBuffered = null;
    diag.consoleFramesSent = null;
    diag.consoleFramesDropped = null;
    diag.decodeQueueSamples = [];
}

// 发送控制指令
function isP2PControlReady() {
    return useWebRTC && dataChannel && dataChannel.readyState === 'open';
}

function sendControl(action) {
    if (!currentDevice) {
        alert('请先选择一个设备');
        return;
    }

    if (isP2PControlReady()) {
        dataChannel.send(JSON.stringify({
            type: 'control',
            action: action
        }));
        return;
    }

    // 回退到 WebSocket 下发控制指令
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'control',
            action: action,
            deviceId: currentDevice
        }));
        return;
    }

    console.warn('[CONTROL] 控制通道未就绪，已丢弃控制指令:', action);
}

// 断开连接
function disconnect() {
    if (!currentDevice) {
        return;
    }

    // 通知服务器停止设备推流
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'stopDevice',
            deviceId: currentDevice
        }));
        console.log('[DEVICE] 请求停止设备:', currentDevice);
    }

    // 关闭 WebRTC 连接
    if (keyframeFallbackTimer) {
        clearTimeout(keyframeFallbackTimer);
        keyframeFallbackTimer = null;
    }
    closeWebRTC();
    currentEpoch++;
    diag.connectionType = '-';
    diag.profile = selectedProfile;

    currentDevice = null;

    if (videoDecoder && videoDecoder.state !== 'unconfigured') {
        videoDecoder.reset();
    }
    nalBuffer = [];
    waitingForKeyframe = false;

    document.getElementById('noDevice').style.display = 'block';
    document.getElementById('videoCanvas').style.display = 'none';
    document.querySelectorAll('.device-item').forEach(item => {
        item.classList.remove('selected');
    });
}

// 更新连接状态
function updateStatus(connected, text) {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    if (connected) {
        statusDot.classList.add('connected');
    } else {
        statusDot.classList.remove('connected');
    }
    
    statusText.textContent = text;
}

// 显示错误信息
function showError(message) {
    const videoContainer = document.getElementById('videoContainer');
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #e74c3c; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 5px; max-width: 80%; z-index: 1000;';
    errorDiv.textContent = message;
    videoContainer.appendChild(errorDiv);
    
    setTimeout(() => {
        errorDiv.remove();
    }, 5000);
}

// 登出
async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (e) {
        console.error('Logout error:', e);
    }
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    if (ws) {
        try { ws.close(); } catch (_) {}
    }
    if (peerConnection) {
        try { peerConnection.close(); } catch (_) {}
    }
    window.location.href = '/login.html';
}

// Canvas 触摸事件处理
let isTouching = false;
let lastTouchDropLogTime = 0;

function initTouchEvents() {
    if (!canvas) {
        console.error('[TOUCH] Canvas 未初始化');
        return;
    }
    
    // Mouse events
    canvas.addEventListener('mousedown', (e) => {
        if (!currentDevice) return;
        isTouching = true;
        const pos = getCanvasPosition(e);
        sendTouchEvent('down', pos.x, pos.y);
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!currentDevice || !isTouching) return;
        const pos = getCanvasPosition(e);
        sendTouchEvent('move', pos.x, pos.y);
    });

    canvas.addEventListener('mouseup', (e) => {
        if (!currentDevice || !isTouching) return;
        isTouching = false;
        const pos = getCanvasPosition(e);
        sendTouchEvent('up', pos.x, pos.y);
    });

    canvas.addEventListener('mouseleave', (e) => {
        if (!currentDevice || !isTouching) return;
        isTouching = false;
        const pos = getCanvasPosition(e);
        sendTouchEvent('up', pos.x, pos.y);
    });

    // Touch events
    canvas.addEventListener('touchstart', (e) => {
        if (!currentDevice) return;
        e.preventDefault();
        isTouching = true;
        const touch = e.changedTouches[0];
        const pos = getCanvasPosition(touch);
        sendTouchEvent('down', pos.x, pos.y);
    });

    canvas.addEventListener('touchmove', (e) => {
        if (!currentDevice || !isTouching) return;
        e.preventDefault();
        const touch = e.changedTouches[0];
        const pos = getCanvasPosition(touch);
        sendTouchEvent('move', pos.x, pos.y);
    });

    canvas.addEventListener('touchend', (e) => {
        if (!currentDevice) return;
        e.preventDefault();
        isTouching = false;
        const touch = e.changedTouches[0];
        const pos = getCanvasPosition(touch);
        sendTouchEvent('up', pos.x, pos.y);
    });

    canvas.addEventListener('touchcancel', (e) => {
        if (!currentDevice) return;
        e.preventDefault();
        isTouching = false;
        const touch = e.changedTouches[0];
        const pos = getCanvasPosition(touch);
        sendTouchEvent('up', pos.x, pos.y);
    });
    
    console.log('[TOUCH] 触摸事件已绑定');
}

function getCanvasPosition(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    return {
        x: Math.floor((e.clientX - rect.left) * scaleX),
        y: Math.floor((e.clientY - rect.top) * scaleY)
    };
}

function sendTouchEvent(action, x, y) {
    if (isP2PControlReady()) {
        dataChannel.send(JSON.stringify({
            // 与 scrcpy websocket_sink 控制解析器保持一致
            type: 'control',
            action: 'touch',
            touchType: action,
            x: x,
            y: y,
            width: canvas.width,
            height: canvas.height
        }));
        if (action !== 'move') {
            console.log(`[TOUCH][P2P] ${action} (${x}, ${y})`);
        }
        return;
    }

    // 回退到 WebSocket 下发触控指令
    if (ws && ws.readyState === WebSocket.OPEN && currentDevice) {
        ws.send(JSON.stringify({
            type: 'touch',
            action: action,
            x: x,
            y: y,
            width: canvas.width,
            height: canvas.height
        }));
        if (action !== 'move') {
            console.log(`[TOUCH][WS] ${action} (${x}, ${y})`);
        }
        return;
    }

    // 触摸 move 非常高频，避免刷屏，每 2 秒最多打印一次
    const now = performance.now();
    if (now - lastTouchDropLogTime > 2000) {
        lastTouchDropLogTime = now;
        console.warn('[TOUCH] 控制通道未就绪，触摸事件已丢弃');
    }
}

// 窗口大小改变时调整 canvas
window.addEventListener('resize', adjustCanvasSize);

// 修改设备名称相关变量
let editingDevice = null;
let editingGroupDevice = null;

// 打开修改设备名称模态框
function openEditNameModal(device) {
    editingDevice = device;
    const modal = document.getElementById('editNameModal');
    const input = document.getElementById('deviceNameInput');
    input.value = device.customName || device.model;
    modal.classList.add('show');
    input.focus();
    input.select();
}

// 关闭修改设备名称模态框
function closeEditNameModal() {
    const modal = document.getElementById('editNameModal');
    modal.classList.remove('show');
    editingDevice = null;
}

// 保存设备名称
function saveDeviceName() {
    if (!editingDevice) return;
    
    const input = document.getElementById('deviceNameInput');
    const newName = input.value.trim();
    
    if (!newName) {
        alert('请输入设备名称');
        return;
    }
    
    // 发送更新请求到服务器
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'updateDeviceName',
            deviceId: `${editingDevice.consoleId}:${editingDevice.serial}`,
            customName: newName
        }));
        console.log('[DEVICE] 请求更新设备名称:', editingDevice.serial, '->', newName);
    }
    
    closeEditNameModal();
}

// 打开修改设备分组模态框
function openEditGroupModal(device) {
    editingGroupDevice = device;
    const modal = document.getElementById('editGroupModal');
    const input = document.getElementById('deviceGroupInput');
    input.value = device.groupName || '';
    modal.classList.add('show');
    input.focus();
    input.select();
}

// 关闭修改设备分组模态框
function closeEditGroupModal() {
    const modal = document.getElementById('editGroupModal');
    modal.classList.remove('show');
    editingGroupDevice = null;
}

// 保存设备分组（留空表示未分组）
function saveDeviceGroup() {
    if (!editingGroupDevice) return;

    const input = document.getElementById('deviceGroupInput');
    const groupName = input.value.trim();

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'updateDeviceGroup',
            deviceId: `${editingGroupDevice.consoleId}:${editingGroupDevice.serial}`,
            groupName: groupName
        }));
        console.log('[DEVICE] 请求更新设备分组:', editingGroupDevice.serial, '->', groupName || '(未分组)');
    }

    closeEditGroupModal();
}

// 模态框背景点击关闭
document.addEventListener('DOMContentLoaded', () => {
    const nameModal = document.getElementById('editNameModal');
    nameModal.addEventListener('click', (e) => {
        if (e.target === nameModal) {
            closeEditNameModal();
        }
    });
    
    // 输入框回车键保存
    const input = document.getElementById('deviceNameInput');
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            saveDeviceName();
        } else if (e.key === 'Escape') {
            closeEditNameModal();
        }
    });

    const groupModal = document.getElementById('editGroupModal');
    groupModal.addEventListener('click', (e) => {
        if (e.target === groupModal) {
            closeEditGroupModal();
        }
    });

    const groupInput = document.getElementById('deviceGroupInput');
    groupInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            saveDeviceGroup();
        } else if (e.key === 'Escape') {
            closeEditGroupModal();
        }
    });
});
