#!/usr/bin/env node
// Imports teas.json into an existing user's account.
// Usage: node scripts/import-teas.js <username> [path/to/teas.json]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const username = (process.argv[2] || '').trim().toLowerCase();
const teasPath = process.argv[3] || path.join(__dirname, '..', 'teas.json');

if (!username) {
  console.error('Usage: node scripts/import-teas.js <username> [path/to/teas.json]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!fs.existsSync(teasPath)) {
  console.error(`File not found: ${teasPath}`);
  process.exit(1);
}

function migrateTea(tea) {
  if (Array.isArray(tea.sessions)) return tea;
  const { temp, grams, ml, steep, notes, ...rest } = tea;
  const hasBrew = temp || grams || ml || steep || notes;
  const sessions = hasBrew ? [{
    id: (tea.id || Date.now().toString()) + '-1',
    date: tea.date || new Date().toISOString(),
    temp: temp || '',
    grams: grams || '',
    ml: ml || '',
    steep: steep || '',
    notes: notes || '',
  }] : [];
  return { ...rest, sessions };
}

function withLibpqCompat(url) {
  if (!url || url.includes('uselibpqcompat=')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'uselibpqcompat=true';
}

const pool = new pg.Pool({
  connectionString: withLibpqCompat(process.env.DATABASE_URL),
  ssl: process.env.DATABASE_URL.includes('sslmode=disable')
    ? false
    : { rejectUnauthorized: false },
});

(async () => {
  const userResult = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (userResult.rows.length === 0) {
    console.error(`No user with username "${username}". Create the account first with scripts/create-user.js.`);
    process.exit(1);
  }
  const userId = userResult.rows[0].id;

  const raw = JSON.parse(fs.readFileSync(teasPath, 'utf8'));
  const teas = raw.map(migrateTea);

  let inserted = 0;
  let skipped = 0;
  for (const t of teas) {
    const id = t.id || Date.now().toString() + Math.random().toString(36).slice(2, 6);
    try {
      await pool.query(
        `INSERT INTO teas (id, user_id, name, type, origin, vendor, season, rating, buy_again, purchase_link, date, sessions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          userId,
          t.name,
          t.type || null,
          t.origin || null,
          t.vendor || null,
          t.season || null,
          Number.isFinite(+t.rating) ? +t.rating : 0,
          t.buyAgain || 'not-tried',
          t.purchaseLink || null,
          t.date || new Date().toISOString(),
          JSON.stringify(t.sessions || []),
        ]
      );
      inserted++;
    } catch (err) {
      console.error(`Failed to insert tea "${t.name}":`, err.message);
      skipped++;
    }
  }

  console.log(`Imported ${inserted} teas for ${username} (skipped ${skipped}).`);
  await pool.end();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
