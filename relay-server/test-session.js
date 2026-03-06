const session = require('express-session');
const express = require('express');
const app = express();

// Test session configuration
const sessionConfig = {
    secret: 'test-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 3600000
    }
};

app.use(session(sessionConfig));
app.use(express.json());

app.post('/test-login', (req, res) => {
    console.log('Session before login:', req.session);
    req.session.user = { username: 'testuser' };
    console.log('Session after login:', req.session);
    res.json({ success: true, message: 'Test login successful' });
});

app.get('/test-protected', (req, res) => {
    console.log('Protected route session:', req.session);
    if (req.session.user) {
        res.json({ success: true, user: req.session.user });
    } else {
        res.status(401).json({ error: '未授权访问' });
    }
});

const server = app.listen(3001, () => {
    console.log('Test server running on port 3001');
});

// Test the session
setTimeout(() => {
    const http = require('http');
    
    // Test login
    const loginData = JSON.stringify({ username: 'test', password: 'test' });
    const loginReq = http.request({
        hostname: 'localhost',
        port: 3001,
        path: '/test-login',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': loginData.length
        }
    }, (res) => {
        console.log('\n=== Test Login Response ===');
        console.log('Status:', res.statusCode);
        console.log('Headers:', res.headers);
        
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            console.log('Response:', data);
            console.log('Set-Cookie:', res.headers['set-cookie']);
        });
    });
    
    loginReq.write(loginData);
    loginReq.end();
    
    // Test protected route
    setTimeout(() => {
        const protectedReq = http.request({
            hostname: 'localhost',
            port: 3001,
            path: '/test-protected',
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        }, (res) => {
            console.log('\n=== Test Protected Response ===');
            console.log('Status:', res.statusCode);
            
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                console.log('Response:', data);
            });
        });
        
        protectedReq.end();
        
        setTimeout(() => {
            server.close();
            console.log('\nTest completed');
        }, 1000);
    }, 1000);
}, 1000);