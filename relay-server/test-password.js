const bcrypt = require('bcryptjs');

// Test the current password hash
const passwordHash = "$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi";
const testPasswords = ['admin123', 'password', 'admin', '123456'];

console.log('Testing password hashes:');
testPasswords.forEach(password => {
    const hash = bcrypt.hashSync(password, 10);
    console.log(`${password}: ${hash}`);
    const matches = bcrypt.compareSync(password, passwordHash);
    console.log(`  Matches current hash: ${matches}`);
});

// Let's also check if the current hash matches any known password
console.log('\nTesting if current hash matches common passwords:');
testPasswords.forEach(password => {
    const matches = bcrypt.compareSync(password, passwordHash);
    console.log(`Current hash matches '${password}': ${matches}`);
});