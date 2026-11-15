// Makes a user entry for the USERS secret of the login service.
// Usage: node hash-password.mjs <email> "<name>" <password>
// Put the printed entries in a JSON list, e.g. [{...}, {...}], then: npx wrangler secret put USERS
import { hashPassword } from './src/index.js';

const [email, name, password] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('Usage: node hash-password.mjs <email> "<name>" <password>');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Use a password of at least 10 characters.');
  process.exit(1);
}
const salt = crypto.randomUUID();
const iterations = 100000; // the most Cloudflare Workers allow
console.log(JSON.stringify({ email: email.toLowerCase(), name, salt, hash: await hashPassword(password, salt, iterations), iterations }));
