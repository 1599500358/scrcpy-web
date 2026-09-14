const http = require('http');

// Test the protected endpoint first (should fail without auth)
console.log('=== Testing protected endpoint without authentication ===');
const options1 = {
  hostname: 'localhost',
  port: 8080,
  path: '/api/devices',
  method: 'GET',
  headers: {
    'Accept': 'application/json'
  }
};

const req1 = http.request(options1, (res) => {
  console.log(`Protected endpoint status: ${res.statusCode}`);
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('Protected endpoint response:', data);
  });
});
req1.on('error', (e) => {
  console.error('Protected endpoint error:', e.message);
});
req1.end();

// Now test login
setTimeout(() => {
  console.log('\n=== Testing login ===');
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
    console.log(`Login status: ${res.statusCode}`);
    console.log('Login response headers:', res.headers);
    
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log('Login response:', data);
      
      // Extract session cookie
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        console.log('Session cookie found:', setCookie);
        const sessionCookie = setCookie[0].split(';')[0];
        console.log('Extracted session cookie:', sessionCookie);
        
        // Test protected endpoint with session cookie
        testProtectedWithCookie(sessionCookie);
      } else {
        console.log('No session cookie found in response');
      }
    });
  });

  loginReq.on('error', (e) => {
    console.error('Login error:', e.message);
  });
  
  loginReq.write(loginData);
  loginReq.end();
}, 1000);

function testProtectedWithCookie(cookie) {
  setTimeout(() => {
    console.log('\n=== Testing protected endpoint with authentication ===');
    const options2 = {
      hostname: 'localhost',
      port: 8080,
      path: '/api/devices',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookie
      }
    };

    const req2 = http.request(options2, (res) => {
      console.log(`Protected endpoint with auth status: ${res.statusCode}`);
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        console.log('Protected endpoint with auth response:', data);
      });
    });
    req2.on('error', (e) => {
      console.error('Protected endpoint with auth error:', e.message);
    });
    req2.end();
  }, 1000);
}