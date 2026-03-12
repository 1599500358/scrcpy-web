module.exports = {
  apps: [{
    name: 'scrcpy-relay-server',
    script: './server.js',
    cwd: '/home/ubuntu/scrcpy-web/relay-server',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      ENABLE_HTTPS: 'true',
      HTTPS_PORT: '8443',
      HTTP_PORT: '8080',
      SSL_CERT_PATH: '/home/ubuntu/scrcpy-web/relay-server/cert/server.crt',
      SSL_KEY_PATH: '/home/ubuntu/scrcpy-web/relay-server/cert/server.key',
      LOG_LEVEL: 'INFO'
    },
    // 日志配置
    log_file: '/home/ubuntu/scrcpy-web/relay-server/logs/combined.log',
    out_file: '/home/ubuntu/scrcpy-web/relay-server/logs/out.log',
    error_file: '/home/ubuntu/scrcpy-web/relay-server/logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // 自动重启配置
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    // 内存限制
    max_memory_restart: '500M',
    // 监控和调试
    watch: false,
    // 启动等待时间
    listen_timeout: 10000,
    kill_timeout: 5000,
    // 优雅关闭
    wait_ready: true,
    // PM2 内置负载均衡（如果需要多实例）
    // instances: 'max', // 或指定数字如 2
    // exec_mode: 'cluster',
  }]
};
