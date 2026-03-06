const WebSocket = require('ws');

// 测试控制台连接（不需要认证）
console.log('=== Testing Console WebSocket Connection ===');

const ws = new WebSocket('ws://localhost:8080?type=console');

ws.on('open', function open() {
    console.log('✓ WebSocket connection established (console - no auth required)');
    
    // 发送设备列表更新
    const deviceListMsg = {
        type: 'deviceList',
        devices: [
            {
                serial: 'test-device-123',
                model: 'Test Device',
                brand: 'TestBrand',
                android_version: '11',
                screen_width: 1080,
                screen_height: 1920
            }
        ]
    };
    
    ws.send(JSON.stringify(deviceListMsg));
    console.log('✓ Sent device list update');
});

ws.on('message', function message(data) {
    console.log('✓ Received message:', data.toString());
});

ws.on('close', function close(code, reason) {
    console.log(`✓ WebSocket closed with code: ${code}, reason: ${reason}`);
});

ws.on('error', function error(err) {
    console.error('✗ WebSocket error:', err.message);
});