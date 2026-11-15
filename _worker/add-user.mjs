// Adds a user to the admin page's database with a new random password, which it prints.
// Usage: node add-user.mjs <email> "<name>" [--local]
// (--local uses the local test database of `wrangler dev` instead of the real one)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { hashPassword, ITERATIONS } from './src/password.js';

const [email, name] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!email || !name) {
  console.error('Usage: node add-user.mjs <email> "<name>" [--local]');
  process.exit(1);
}
// readable password: no 0/O or 1/l/I
const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const password = Array.from({ length: 14 }, () => chars[randomInt(chars.length)]).join('');
const salt = crypto.randomUUID();
const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;
const command = `INSERT INTO users (email, name, salt, hash, iterations) VALUES (${sql(email.toLowerCase())}, ${sql(name)}, ${sql(salt)}, ${sql(await hashPassword(password, salt))}, ${ITERATIONS})
  ON CONFLICT(email) DO UPDATE SET name = excluded.name, salt = excluded.salt, hash = excluded.hash, iterations = excluded.iterations, updated_at = CURRENT_TIMESTAMP`;
// the SQL goes through a file: on Windows a --command argument would be split by the shell
const dir = mkdtempSync(join(tmpdir(), 'add-user-'));
try {
  writeFileSync(join(dir, 'user.sql'), command + ';\n');
  execFileSync('npx', ['wrangler@4.156.0', 'd1', 'execute', 'gabriel-cms', process.argv.includes('--local') ? '--local' : '--remote', '--yes', '--file', join(dir, 'user.sql')],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`User ${email.toLowerCase()} is ready. Password: ${password}`);
