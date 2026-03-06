const http = require('http');

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
  console.log(`状态码: ${res.statusCode}`);
  console.log(`响应头: ${JSON.stringify(res.headers)}`);

  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log('响应数据:', data);
  });
});

req.on('error', (e) => {
  console.error(`请求错误: ${e.message}`);
});

req.end();