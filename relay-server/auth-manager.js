const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

class AuthManager {
    constructor(configPath) {
        this.configPath = configPath;
        this.config = this.loadConfig();
        this.loginAttempts = new Map();
    }

    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            }
        } catch (error) {
            console.error('Error loading auth config:', error);
        }
        return { users: [], sessionConfig: {}, security: {} };
    }

    saveConfig() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
        } catch (error) {
            console.error('Error saving auth config:', error);
        }
    }

    async hashPassword(password) {
        return bcrypt.hash(password, 10);
    }

    async comparePassword(password, hash) {
        return bcrypt.compare(password, hash);
    }

    isLockedOut(username) {
        const attempts = this.loginAttempts.get(username);
        if (!attempts) return false;
        
        const { count, lastAttempt } = attempts;
        const lockoutTime = this.config.security.lockoutTime || 900000; // 15 minutes
        const maxAttempts = this.config.security.maxLoginAttempts || 5;
        
        if (count >= maxAttempts && Date.now() - lastAttempt < lockoutTime) {
            return true;
        }
        
        if (Date.now() - lastAttempt >= lockoutTime) {
            this.loginAttempts.delete(username);
        }
        
        return false;
    }

    recordLoginAttempt(username, success) {
        if (success) {
            this.loginAttempts.delete(username);
            return;
        }
        
        const attempts = this.loginAttempts.get(username) || { count: 0, lastAttempt: 0 };
        attempts.count++;
        attempts.lastAttempt = Date.now();
        this.loginAttempts.set(username, attempts);
    }

    async authenticate(username, password) {
        if (this.isLockedOut(username)) {
            return { success: false, message: '账户已锁定，请15分钟后再试' };
        }

        const user = this.config.users.find(u => u.username === username);
        if (!user) {
            this.recordLoginAttempt(username, false);
            return { success: false, message: '用户名或密码错误' };
        }

        const isValid = await this.comparePassword(password, user.passwordHash);
        if (!isValid) {
            this.recordLoginAttempt(username, false);
            return { success: false, message: '用户名或密码错误' };
        }

        this.recordLoginAttempt(username, true);
        return { 
            success: true, 
            user: { 
                username: user.username, 
                role: user.role 
            } 
        };
    }

    requireAuth(req, res, next) {
        if (req.session && req.session.user) {
            next();
        } else {
            const acceptsJson = req.headers.accept && req.headers.accept.indexOf('json') > -1;
            if (req.xhr || acceptsJson) {
                res.status(401).json({ error: '未授权访问' });
            } else {
                res.redirect('/login');
            }
        }
    }

    requireRole(role) {
        return (req, res, next) => {
            if (req.session && req.session.user && req.session.user.role === role) {
                next();
            } else {
                res.status(403).json({ error: '权限不足' });
            }
        };
    }

    async addUser(username, password, role = 'user') {
        if (this.config.users.find(u => u.username === username)) {
            throw new Error('用户已存在');
        }

        const passwordHash = await this.hashPassword(password);
        const user = {
            username,
            passwordHash,
            role,
            createdAt: new Date().toISOString()
        };

        this.config.users.push(user);
        this.saveConfig();
        return user;
    }

    getSessionConfig() {
        return this.config.sessionConfig;
    }
}

module.exports = AuthManager;