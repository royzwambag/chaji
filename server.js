import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import bcrypt from 'bcrypt';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3333;
const PROD = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: withLibpqCompat(process.env.DATABASE_URL),
  ssl: process.env.DATABASE_URL.includes('sslmode=disable')
    ? false
    : { rejectUnauthorized: false },
});

function withLibpqCompat(url) {
  if (!url || url.includes('uselibpqcompat=')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'uselibpqcompat=true';
}

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
}

const app = express();
if (PROD) app.set('trust proxy', 1);

app.use(express.json({ limit: '12mb' }));

const PgStore = connectPgSimple(session);
app.use(session({
  store: new PgStore({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: PROD,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
}));

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
if (!anthropic) console.warn('No ANTHROPIC_API_KEY set — /api/brew will fail.');

// ─── Auth ───────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const result = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    const ok = user && await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    res.json({ email: user.email });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  const result = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not signed in' });
  }
  res.json({ email: user.email });
});

// ─── Teas ───────────────────────────────────────────────────────

function rowToTea(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type || '',
    origin: row.origin || '',
    vendor: row.vendor || '',
    season: row.season || '',
    rating: row.rating || 0,
    buyAgain: row.buy_again || 'not-tried',
    purchaseLink: row.purchase_link || '',
    date: row.date instanceof Date ? row.date.toISOString() : row.date,
    sessions: Array.isArray(row.sessions) ? row.sessions : [],
  };
}

app.get('/api/teas', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM teas WHERE user_id = $1 ORDER BY date DESC',
      [req.session.userId]
    );
    res.json(result.rows.map(rowToTea));
  } catch (err) {
    console.error('Get teas error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/teas', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || typeof b.name !== 'string') return res.status(400).json({ error: 'name required' });
    const id = Date.now().toString();
    const result = await pool.query(
      `INSERT INTO teas (id, user_id, name, type, origin, vendor, season, rating, buy_again, purchase_link, sessions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        id,
        req.session.userId,
        b.name.trim(),
        b.type || null,
        b.origin || null,
        b.vendor || null,
        b.season || null,
        Number.isFinite(+b.rating) ? +b.rating : 0,
        b.buyAgain || 'not-tried',
        b.purchaseLink || null,
        JSON.stringify(Array.isArray(b.sessions) ? b.sessions : []),
      ]
    );
    res.json(rowToTea(result.rows[0]));
  } catch (err) {
    console.error('Create tea error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/teas/:id', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const result = await pool.query(
      `UPDATE teas SET
         name = $1, type = $2, origin = $3, vendor = $4, season = $5,
         rating = $6, buy_again = $7, purchase_link = $8, sessions = $9
       WHERE id = $10 AND user_id = $11
       RETURNING *`,
      [
        b.name ? b.name.trim() : '',
        b.type || null,
        b.origin || null,
        b.vendor || null,
        b.season || null,
        Number.isFinite(+b.rating) ? +b.rating : 0,
        b.buyAgain || 'not-tried',
        b.purchaseLink || null,
        JSON.stringify(Array.isArray(b.sessions) ? b.sessions : []),
        req.params.id,
        req.session.userId,
      ]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rowToTea(result.rows[0]));
  } catch (err) {
    console.error('Update tea error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/teas/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM teas WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete tea error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Brew Helper ────────────────────────────────────────────────

const BREWING_SCHEMA = {
  type: 'object',
  properties: {
    teaName: { type: 'string', description: 'Best identification of the tea' },
    teaType: {
      type: 'string',
      description: 'Category, e.g., sheng puerh, shou puerh, yancha, dancong, gyokuro, white peony, dianhong, etc.'
    },
    origin: { type: 'string', description: 'Origin region if known, otherwise "unknown"' },
    method: { type: 'string', enum: ['gaiwan', 'western'] },
    vesselSize: { type: 'string', description: 'Recommended vessel size in ml' },
    leafAmount: { type: 'string', description: 'Recommended leaf amount in grams' },
    ratioInfo: { type: 'string', description: 'Leaf:water ratio, ≤10 words' },
    waterTemp: { type: 'string', description: '°C and °F, e.g. "90°C (194°F)"' },
    rinseRecommendation: {
      type: 'string',
      description: '≤10 words. e.g. "Quick 5s rinse" or "No rinse needed"'
    },
    steeps: {
      type: 'array',
      description: 'Recommended sequence of steeps. Keep notes ≤6 words each.',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          duration: { type: 'string', description: "e.g. '5s', '10s', '2min'" },
          notes: { type: 'string', description: '≤6 words on character (e.g. "bright, floral opening")' }
        },
        required: ['number', 'duration', 'notes'],
        additionalProperties: false
      }
    },
    maxSteeps: { type: 'integer', description: 'Total recommended infusions' },
    expectedFlavors: {
      type: 'array',
      description: 'Up to 5 short flavor/aroma notes',
      items: { type: 'string' }
    }
  },
  required: [
    'teaName', 'teaType', 'origin', 'method', 'vesselSize', 'leafAmount',
    'ratioInfo', 'waterTemp', 'rinseRecommendation', 'steeps', 'maxSteeps',
    'expectedFlavors'
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are an expert tea master specializing in Chinese gong fu cha and traditional tea brewing. Given a tea (by name, packaging photo, or web page text) and a brewing method, output precise brewing instructions.

Brewing methods:
- gaiwan (gong fu cha — gaiwan or small teapot): 100-150ml vessel default, high leaf-to-water ratio (~1g per 15-20ml), short flash steeps that build over many infusions. Default to ~7-8g for 100ml unless tea calls for different. If user mentioned a teapot in vessel size, instructions apply identically; for clay/yixing teapots add ~2-3 seconds to each steep due to thicker walls.
- western: 300-500ml volume, low leaf-to-water ratio (2-3g per 200ml), long steeps (2-5 minutes), 1-3 infusions only.

Temperature guidance by category:
- Green tea, Japanese greens: 70-80°C
- White tea (silver needle, white peony): 80-90°C
- Light oolong (TGY, baozhong, light dancong): 90-95°C
- Dark/roasted oolong (yancha, traditional TGY, aged): 95-100°C
- Black/red tea (dianhong, jin jun mei): 90-95°C
- Sheng puerh (young): 90-95°C
- Sheng puerh (aged): 95-100°C
- Shou puerh: 95-100°C (boiling fine)
- Heicha, liu bao: boiling

For gong fu, build steeps gradually — first 3-4 are flash (5-15s), then add 5-10s each subsequent steep. Aged/compressed teas usually want a rinse; greens and lighter teas don't.

If the specific tea cannot be identified, give best-guess parameters based on visible category. Be specific and confident.

Be terse. Short phrases, no marketing prose. Steep notes are ≤6 words each.`;

async function fetchUrlText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    },
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2500);
}

async function buildPrompt({ teaName, url, image, method, vesselSize }) {
  let prompt = `Brewing method: ${method}\n`;
  if (vesselSize) prompt += `Vessel size: ${vesselSize}\n`;
  prompt += '\n';
  if (teaName) prompt += `Tea: ${teaName}\n\n`;
  if (url) {
    try {
      const pageText = await fetchUrlText(url);
      prompt += `Source URL: ${url}\n\nPage content (text extracted):\n"""\n${pageText}\n"""\n\n`;
    } catch (err) {
      prompt += `Source URL: ${url} (could not be fetched: ${err.message})\n\n`;
    }
  }
  if (image) prompt += 'A photo of the tea packaging is provided. Identify the tea from the packaging.\n\n';
  prompt += 'Provide detailed brewing instructions following the schema. If the tea cannot be precisely identified, make reasonable assumptions based on what you can determine and note them in tips.';
  return prompt;
}

async function brewWithAnthropic({ prompt, image, imageMediaType }) {
  const userContent = [];
  if (image) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: image }
    });
  }
  userContent.push({ type: 'text', text: prompt });

  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
    max_tokens: 600,
    output_config: {
      format: { type: 'json_schema', schema: BREWING_SCHEMA }
    },
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
    ],
    messages: [{ role: 'user', content: userContent }]
  }, { timeout: 45000 });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Empty response from Anthropic');
  return JSON.parse(textBlock.text);
}

app.post('/api/brew', requireAuth, async (req, res) => {
  try {
    const { teaName, image, imageMediaType, url, method, vesselSize } = req.body;

    if (!method || !['gaiwan', 'western'].includes(method)) {
      return res.status(400).json({ error: 'method must be gaiwan or western' });
    }
    if (!teaName && !image && !url) {
      return res.status(400).json({ error: 'Provide a tea name, image, or URL' });
    }
    if (!anthropic) {
      return res.status(500).json({ error: 'No AI provider configured. Set ANTHROPIC_API_KEY.' });
    }

    const prompt = await buildPrompt({ teaName, url, image, method, vesselSize });
    const data = await brewWithAnthropic({ prompt, image, imageMediaType });

    res.json(data);
  } catch (err) {
    console.error('Brew error:', err);
    const isTimeout = err.name === 'AbortError' || /timeout|timed out/i.test(err.message || '');
    const status = isTimeout ? 504 : (err.status || 500);
    const message = isTimeout
      ? 'Tea master is taking too long to respond — try again.'
      : (err.message || 'Server error');
    res.status(status).json({ error: message });
  }
});

// Static AFTER API routes so they take precedence.
app.use(express.static(__dirname));

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Cha Ji running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize schema:', err);
    process.exit(1);
  });
