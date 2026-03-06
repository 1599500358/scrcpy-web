const http = require('http');

// Test the actual server's authentication flow
console.log('=== Testing Server Authentication Flow ===\n');

// Step 1: Test protected endpoint without auth (should fail)
console.log('1. Testing protected endpoint without authentication...');
const testProtected = () => {
    const options = {
        hostname: 'localhost',
        port: 8080,
        path: '/api/devices',
        method: 'GET',
        headers: {
            'Accept': 'application/json'
        }
    };

    const req = http.request(options, (res) => {
        console.log(`   Status: ${res.statusCode}`);
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        res.on('end', () => {
            console.log(`   Response: ${data}`);
            console.log('   ✓ Protected endpoint correctly requires authentication\n');
            
            // Now test login
            setTimeout(testLogin, 500);
        });
    });

    req.on('error', (e) => {
        console.error(`   Error: ${e.message}`);
    });
    req.end();
};

// Step 2: Test login (should succeed and set cookie)
let sessionCookie = null;

const testLogin = () => {
    console.log('2. Testing login...');
    const loginData = JSON.stringify({
        username: 'admin',
        password: 'password'
    });

    const options = {
        hostname: 'localhost',
        port: 8080,
        path: '/api/login',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': loginData.length
        }
    };

    const req = http.request(options, (res) => {
        console.log(`   Status: ${res.statusCode}`);
        console.log(`   Headers:`, res.headers);
        
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            console.log(`   Response: ${data}`);
            
            // Extract session cookie
            const setCookie = res.headers['set-cookie'];
            if (setCookie && setCookie.length > 0) {
                sessionCookie = setCookie[0].split(';')[0];
                console.log(`   ✓ Session cookie obtained: ${sessionCookie}\n`);
                
                // Test protected endpoint with cookie
                setTimeout(() => testProtectedWithAuth(sessionCookie), 500);
            } else {
                console.log('   ✗ No session cookie found in response');
                console.log('   This might indicate a session configuration issue\n');
            }
        });
    });

    req.on('error', (e) => {
        console.error(`   Error: ${e.message}`);
    });
    
    req.write(loginData);
    req.end();
};

// Step 3: Test protected endpoint with auth (should succeed)
const testProtectedWithAuth = (cookie) => {
    console.log('3. Testing protected endpoint with authentication...');
    const options = {
        hostname: 'localhost',
        port: 8080,
        path: '/api/devices',
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'Cookie': cookie
        }
    };

    const req = http.request(options, (res) => {
        console.log(`   Status: ${res.statusCode}`);
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        res.on('end', () => {
            console.log(`   Response: ${data}`);
            if (res.statusCode === 200) {
                console.log('   ✓ Protected endpoint accessible with authentication\n');
            } else {
                console.log('   ✗ Protected endpoint still rejecting authenticated requests\n');
            }
            
            // Test WebSocket connection
            setTimeout(testWebSocketAuth, 500);
        });
    });

    req.on('error', (e) => {
        console.error(`   Error: ${e.message}`);
    });
    req.end();
};

// Step 4: Test WebSocket authentication
const testWebSocketAuth = () => {
    console.log('4. Testing WebSocket authentication...');
    
    if (!sessionCookie) {
        console.log('   ✗ Cannot test WebSocket - no session cookie available');
        return;
    }
    
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:8080?type=web', {
        headers: {
            'Cookie': sessionCookie
        }
    });
    
    ws.on('open', () => {
        console.log('   ✓ WebSocket connection established with authentication');
        ws.close();
    });
    
    ws.on('error', (error) => {
        console.log(`   ✗ WebSocket connection failed: ${error.message}`);
    });
    
    ws.on('close', (code, reason) => {
        console.log(`   WebSocket closed with code: ${code}, reason: ${reason}`);
    });
};

// Start the test
console.log('Starting authentication tests...\n');
testProtected();