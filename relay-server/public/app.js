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

// H.264 流缓冲
let nalBuffer = [];

// 性能统计
let frameCount = 0;
let lastFrameTime = 0;
let lastStatsTime = 0;
let bytesReceived = 0;

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

    // 初始化触摸事件
    initTouchEvents();

    console.log('[INIT] 初始化完成, WebRTC:', webrtcEnabled ? '启用' : '禁用');
};

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

    try {
        peerConnection = new RTCPeerConnection(rtcConfig);

        // 监听 DataChannel
        peerConnection.ondatachannel = (event) => {
            console.log('[WebRTC] 收到 DataChannel:', event.channel.label);
            dataChannel = event.channel;
            setupDataChannel(dataChannel, deviceId);
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
                console.log('[WebRTC] ✅ P2P 连接成功');
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
function setupDataChannel(channel, deviceId) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
        console.log('[WebRTC] DataChannel 已打开');
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
        if (event.data instanceof ArrayBuffer) {
            // 更新统计
            bytesReceived += event.data.byteLength;

            // 兼容分片/非分片两种格式
            handleIncomingVideoData(new Uint8Array(event.data));
        }
    };
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
    ctx.drawImage(frame, 0, 0);
    frame.close();
    
    // 计算帧率
    const now = performance.now();
    if (lastFrameTime > 0) {
        const delta = now - lastFrameTime;
        const fps = 1000 / delta;
        
        // 每秒更新一次统计
        if (now - lastStatsTime > 1000) {
            console.log(`[STATS] FPS: ${fps.toFixed(1)}, 帧数: ${frameCount}, 接收: ${(bytesReceived / 1024).toFixed(1)} KB/s`);
            lastStatsTime = now;
            bytesReceived = 0;
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
    
    ws.onclose = () => {
        console.log('[WS] 连接已关闭，3秒后重连...');
        updateStatus(false, '连接断开');
        setTimeout(connectWebSocket, 3000);
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
                showError(message.message);
                break;
            case 'startDeviceFailed':
                showError(message.message || '设备启动失败');
                console.error('[DEVICE] 启动失败:', message);
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
            
            // 如果有 SPS 和 PPS，配置解码器
            if (nalBuffer.length >= 2 && videoDecoder.state === 'unconfigured') {
                const config = buildDecoderConfig(nalBuffer);
                if (config) {
                    configureDecoder(config.codec, config.description);
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

// 更新设备列表
function updateDeviceList(devices) {
    const deviceList = document.getElementById('deviceList');
    const statsInfo = document.getElementById('statsInfo');
    
    // 添加调试信息
    console.log('[DEVICE] 接收到设备列表:', devices);
    
    if (!devices || devices.length === 0) {
        deviceList.innerHTML = '<li class="no-device">等待控制台连接...</li>';
        statsInfo.textContent = '控制台: 0 | 设备: 0';
        return;
    }
    
    // 统计控制台数量
    const consoles = new Set(devices.map(d => d.consoleId));
    statsInfo.textContent = `控制台: ${consoles.size} | 设备: ${devices.length}`;
    
    deviceList.innerHTML = '';
    
    devices.forEach(device => {
        const li = document.createElement('li');
        li.className = 'device-item';
        li.dataset.deviceId = `${device.consoleId}:${device.serial}`;
        
        // 缩略图容器
        const thumbnailContainer = document.createElement('div');
        thumbnailContainer.className = 'device-thumbnail';
        
        // 缩略图
        const thumbnail = document.createElement('img');
        thumbnail.style.cssText = 'max-width: 100%; max-height: 100%; object-fit: contain;';
        if (device.thumbnail) {
            console.log(`[DEVICE] 设备 ${device.serial} 有缩略图数据，长度: ${device.thumbnail.length}`);
            thumbnail.src = `data:image/jpeg;base64,${device.thumbnail}`;
        } else {
            console.log(`[DEVICE] 设备 ${device.serial} 没有缩略图数据`);
            // 创建一个占位符文本
            thumbnail.style.display = 'none';
            const placeholder = document.createElement('span');
            placeholder.textContent = '无预览';
            placeholder.style.cssText = 'color: #666; font-size: 12px;';
            thumbnailContainer.appendChild(placeholder);
        }
        thumbnail.alt = device.customName || device.model;
        
        thumbnailContainer.appendChild(thumbnail);
        
        // 设备详情
        const details = document.createElement('div');
        details.className = 'device-details';
        
        // 名称行
        const nameRow = document.createElement('div');
        nameRow.className = 'device-name-row';
        
        const name = document.createElement('div');
        name.className = 'device-name';
        name.textContent = device.customName || device.model;
        name.title = device.customName || device.model;
        
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-name-btn';
        editBtn.textContent = '修改';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            openEditNameModal(device);
        };
        
        nameRow.appendChild(name);
        nameRow.appendChild(editBtn);
        
        // 设备信息
        const info = document.createElement('div');
        info.className = 'device-info';
        info.textContent = `Serial: ${device.serial.substring(0, 12)}...`;
        
        details.appendChild(nameRow);
        details.appendChild(info);
        
        // 点击选择设备
        li.onclick = () => selectDevice(`${device.consoleId}:${device.serial}`);
        
        if (currentDevice === `${device.consoleId}:${device.serial}`) {
            li.classList.add('selected');
        }
        
        li.appendChild(thumbnailContainer);
        li.appendChild(details);
        deviceList.appendChild(li);
    });
}

// 更新单个设备信息
function updateSingleDevice(device) {
    const deviceList = document.getElementById('deviceList');
    const li = deviceList.querySelector(`li[data-device-id="${device.consoleId}:${device.serial}"]`);
    
    if (!li) return;
    
    // 更新缩略图
    const thumbnail = li.querySelector('.device-thumbnail img');
    if (device.thumbnail) {
        console.log(`[DEVICE] 设备 ${device.serial} 有缩略图数据，长度: ${device.thumbnail.length}`);
        thumbnail.src = `data:image/jpeg;base64,${device.thumbnail}`;
    } else {
        console.log(`[DEVICE] 设备 ${device.serial} 没有缩略图数据`);
        // 创建一个占位符文本
        thumbnail.style.display = 'none';
        const placeholder = document.createElement('span');
        placeholder.textContent = '无预览';
        placeholder.style.cssText = 'color: #666; font-size: 12px;';
        li.querySelector('.device-thumbnail').appendChild(placeholder);
    }
    
    // 更新名称
    const name = li.querySelector('.device-name');
    name.textContent = device.customName || device.model;
    name.title = device.customName || device.model;
}

// 选择设备
function selectDevice(deviceId, evt) {
    console.log('[DEVICE] 选择设备:', deviceId);
    currentDevice = deviceId;

    // 重置解码器
    if (videoDecoder && videoDecoder.state !== 'unconfigured') {
        videoDecoder.reset();
    }
    nalBuffer = [];
    waitingForKeyframe = false;

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
            webrtc: webrtcEnabled // 告诉服务器我们支持 WebRTC
        }));
    }

    // 显示视频区域
    document.getElementById('noDevice').style.display = 'none';
    document.getElementById('videoCanvas').style.display = 'block';
    document.getElementById('loading').style.display = 'flex';

    // 重置统计
    frameCount = 0;
    lastFrameTime = 0;
    lastStatsTime = performance.now();
    bytesReceived = 0;
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

    console.warn('[CONTROL] P2P 通道未就绪，已丢弃控制指令:', action);
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
    closeWebRTC();

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
function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
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

    // 触摸 move 非常高频，避免刷屏，每 2 秒最多打印一次
    const now = performance.now();
    if (now - lastTouchDropLogTime > 2000) {
        lastTouchDropLogTime = now;
        console.warn('[TOUCH] P2P 通道未就绪，触摸事件已丢弃');
    }
}

// 窗口大小改变时调整 canvas
window.addEventListener('resize', adjustCanvasSize);

// 修改设备名称相关变量
let editingDevice = null;

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

// 模态框背景点击关闭
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('editNameModal');
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
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
});
