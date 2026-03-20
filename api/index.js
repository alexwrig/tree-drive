const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json({ limit: '4mb' }));

// ─── DATABASE ─────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 5000,
});

let initialized = false;
async function ensureDb() {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trees (
      id          TEXT    PRIMARY KEY,
      lat         DOUBLE PRECISION NOT NULL,
      lng         DOUBLE PRECISION NOT NULL,
      address     TEXT    NOT NULL,
      trees       INTEGER NOT NULL DEFAULT 1,
      size        TEXT    NOT NULL DEFAULT 'medium',
      notes       TEXT    DEFAULT '',
      spotter     TEXT    DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'available',
      "claimedAt"  BIGINT,
      "pickedUpAt" BIGINT,
      "createdAt"  BIGINT NOT NULL
    )
  `);
  initialized = true;
}

// Wrap async route handlers so Express catches rejections
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/api/trees', wrap(async (_req, res) => {
  await ensureDb();
  const { rows } = await pool.query('SELECT * FROM trees ORDER BY "createdAt" DESC');
  res.json(rows);
}));

app.post('/api/trees', wrap(async (req, res) => {
  await ensureDb();
  const t = sanitize(req.body);
  if (!t) return res.status(400).json({ error: 'Invalid tree data' });
  await pool.query(
    `INSERT INTO trees (id,lat,lng,address,trees,size,notes,spotter,status,"claimedAt","pickedUpAt","createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [t.id, t.lat, t.lng, t.address, t.trees, t.size, t.notes, t.spotter,
     t.status, t.claimedAt, t.pickedUpAt, t.createdAt]
  );
  res.status(201).json(t);
}));

app.patch('/api/trees/:id', wrap(async (req, res) => {
  await ensureDb();
  const allowed = ['status','claimedAt','pickedUpAt','address','trees','size','notes','spotter'];
  const updates = {};
  for (const k of allowed) { if (k in req.body) updates[k] = req.body[k]; }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });

  const keys = Object.keys(updates);
  const fields = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
  await pool.query(
    `UPDATE trees SET ${fields} WHERE id = $${keys.length + 1}`,
    [...Object.values(updates), req.params.id]
  );
  const { rows } = await pool.query('SELECT * FROM trees WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

app.delete('/api/trees', wrap(async (req, res) => {
  await ensureDb();
  if (req.query.status !== 'picked_up') return res.status(400).json({ error: 'Only status=picked_up supported' });
  await pool.query("DELETE FROM trees WHERE status = 'picked_up'");
  res.json({ ok: true });
}));

app.delete('/api/trees/:id', wrap(async (req, res) => {
  await ensureDb();
  await pool.query('DELETE FROM trees WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/trees/bulk', wrap(async (req, res) => {
  await ensureDb();
  const incoming = req.body;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Expected array' });
  let count = 0;
  for (const row of incoming) {
    const t = sanitize(row);
    if (!t) continue;
    const result = await pool.query(
      `INSERT INTO trees (id,lat,lng,address,trees,size,notes,spotter,status,"claimedAt","pickedUpAt","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [t.id, t.lat, t.lng, t.address, t.trees, t.size, t.notes, t.spotter,
       t.status, t.claimedAt, t.pickedUpAt, t.createdAt]
    );
    if (result.rowCount) count++;
  }
  res.json({ imported: count });
}));

// Serve the frontend for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// Global error handler — returns JSON instead of crashing
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function sanitize(b) {
  if (!b || !b.id || b.lat == null || b.lng == null || !b.address) return null;
  return {
    id:        String(b.id).slice(0, 32),
    lat:       parseFloat(b.lat),
    lng:       parseFloat(b.lng),
    address:   String(b.address).slice(0, 200),
    trees:     Math.min(Math.max(parseInt(b.trees) || 1, 1), 999),
    size:      ['small','medium','large'].includes(b.size) ? b.size : 'medium',
    notes:     String(b.notes || '').slice(0, 500),
    spotter:   String(b.spotter || '').slice(0, 20),
    status:    ['available','claimed','picked_up'].includes(b.status) ? b.status : 'available',
    claimedAt:  b.claimedAt  ? parseInt(b.claimedAt)  : null,
    pickedUpAt: b.pickedUpAt ? parseInt(b.pickedUpAt) : null,
    createdAt:  b.createdAt  ? parseInt(b.createdAt)  : Date.now(),
  };
}

module.exports = app;
