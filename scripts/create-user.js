#!/usr/bin/env node
// Creates a user account directly in the database.
// Usage:
//   node scripts/create-user.js <username>              (prompts for password)
//   node scripts/create-user.js <username> <password>   (password as arg — visible in shell history)

import readline from 'readline';
import pg from 'pg';
import bcrypt from 'bcrypt';
import 'dotenv/config';

const username = (process.argv[2] || '').trim().toLowerCase();
const passwordArg = process.argv[3];

if (!username) {
  console.error('Usage: node scripts/create-user.js <username> [password]');
  process.exit(1);
}
if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
  console.error('Username must be 3–32 chars, lowercase letters/digits/_/./-');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

function withLibpqCompat(url) {
  if (!url || url.includes('uselibpqcompat=')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'uselibpqcompat=true';
}

function promptPassword() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdin = process.stdin;
    process.stdout.write('Password (min 8 chars): ');
    let pw = '';
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\r' || c === '\n' || c === '') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) stdin.setRawMode(false);
        process.stdout.write('\n');
        rl.close();
        resolve(pw);
      } else if (c === '') { // Ctrl-C
        process.exit(130);
      } else if (c === '' || c === '\b') { // backspace
        pw = pw.slice(0, -1);
      } else {
        pw += c;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on('data', onData);
  });
}

(async () => {
  const password = passwordArg || await promptPassword();
  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: withLibpqCompat(process.env.DATABASE_URL),
    ssl: process.env.DATABASE_URL.includes('sslmode=disable')
      ? false
      : { rejectUnauthorized: false },
  });

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hash]
    );
    console.log(`Created user #${result.rows[0].id}: ${result.rows[0].username}`);
  } catch (err) {
    if (err.code === '23505') {
      console.error(`User ${username} already exists`);
      process.exit(1);
    }
    throw err;
  } finally {
    await pool.end();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
