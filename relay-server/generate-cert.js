const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const certDir = path.join(__dirname, 'cert');
const certFile = path.join(certDir, 'server.crt');
const keyFile = path.join(certDir, 'server.key');

// 创建 cert 目录
if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir);
    console.log('✅ 创建证书目录: cert/');
}

// 检查是否已存在证书
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    console.log('⚠️  SSL 证书已存在！');
    console.log(`   证书: ${certFile}`);
    console.log(`   密钥: ${keyFile}`);
    console.log('');
    
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    readline.question('是否重新生成证书？(y/N): ', (answer) => {
        readline.close();
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
            generateCertificate();
        } else {
            console.log('取消生成证书');
            process.exit(0);
        }
    });
} else {
    generateCertificate();
}

function generateCertificate() {
    console.log('🔐 正在生成自签名 SSL 证书...');
    console.log('');

    try {
        // 使用 OpenSSL 生成自签名证书（有效期 365 天）
        const command = `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 ` +
            `-keyout "${keyFile}" -out "${certFile}" ` +
            `-subj "/C=CN/ST=Beijing/L=Beijing/O=Scrcpy/OU=Development/CN=localhost"`;

        console.log('执行命令:');
        console.log(command);
        console.log('');

        execSync(command, { stdio: 'inherit' });

        console.log('');
        console.log('✅ SSL 证书生成成功！');
        console.log('');
        console.log('📁 证书位置:');
        console.log(`   证书文件: ${certFile}`);
        console.log(`   密钥文件: ${keyFile}`);
        console.log('');
        console.log('🚀 启动服务器:');
        console.log('   Windows: set USE_HTTPS=true && node server.js');
        console.log('   Linux:   USE_HTTPS=true node server.js');
        console.log('');
        console.log('⚠️  注意: 自签名证书会被浏览器标记为"不安全"');
        console.log('   解决方法: 在浏览器中点击"高级" → "继续访问"');
        console.log('');

    } catch (error) {
        console.error('');
        console.error('❌ 生成证书失败！');
        console.error('');
        console.error('错误信息:', error.message);
        console.error('');
        console.error('可能的原因:');
        console.error('  1. 系统未安装 OpenSSL');
        console.error('  2. OpenSSL 未添加到系统 PATH');
        console.error('');
        console.error('解决方法:');
        console.error('  Windows: 下载并安装 OpenSSL');
        console.error('    - 下载地址: https://slproweb.com/products/Win32OpenSSL.html');
        console.error('    - 或使用 Git Bash (自带 OpenSSL)');
        console.error('');
        console.error('  Linux/Mac: 通常已预装 OpenSSL');
        console.error('    - Ubuntu/Debian: sudo apt-get install openssl');
        console.error('    - Mac: brew install openssl');
        console.error('');
        process.exit(1);
    }
}
