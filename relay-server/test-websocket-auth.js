const WebSocket = require('ws');
const http = require('http');

// First, let's get a session cookie by logging in
const loginData = JSON.stringify({
    username: 'admin',
    password: process.env.TEST_PASSWORD || 'test-password'
});

const loginOptions = {
    hostname: 'localhost',
    port: 8080,
    path: '/api/login',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': loginData.length
    }
};

const loginReq = http.request(loginOptions, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    
    res.on('end', () => {
        console.log('登录响应:', res.statusCode, data);
        console.log('响应头:', res.headers);
        
        // Extract session cookie
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
            const sessionCookie = setCookie[0].split(';')[0];
            console.log('获取到会话cookie:', sessionCookie);
            
            // Now connect to WebSocket with the session cookie
            const ws = new WebSocket('ws://localhost:8080?type=web', {
                headers: {
                    'Cookie': sessionCookie
                }
            });
            
            ws.on('open', () => {
                console.log('WebSocket连接成功');
            });
            
            ws.on('message', (data) => {
                console.log('收到消息:', data.toString());
            });
            
            ws.on('error', (error) => {
                console.error('WebSocket错误:', error);
            });
            
            ws.on('close', (code, reason) => {
                console.log('WebSocket关闭:', code, reason.toString());
            });
        } else {
            console.log('未获取到会话cookie');
        }
    });
});

loginReq.on('error', (e) => {
    console.error('登录请求错误:', e);
});

loginReq.write(loginData);
loginReq.end();