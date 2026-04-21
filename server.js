// MrQ Team Matrix — Express + JSON-file storage
// App-level auth via Auth0 (OIDC) using express-openid-connect.
// /api/health is public; everything else requires a logged-in session.

import 'dotenv/config';
import express from 'express';
import { auth } from 'express-openid-connect';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persistent data directory. On Railway, mount a volume at /data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'members.json');

// ---------------------------------------------------------------------------
// Tiny JSON-file "DB" with atomic writes + process-level mutex.
// Good for teams up to a few hundred people. Swap to Postgres if you outgrow it.
// ---------------------------------------------------------------------------
let members = [];
let nextId = 1;

// Normalise a member to the array-shape: teams/tribes/squads/tags are all arrays.
// Accepts legacy single-value team/tribe/squad strings and promotes them.
function normaliseMember(m) {
  const toArr = (plural, single) => {
    if (Array.isArray(m[plural])) return m[plural].filter(Boolean);
    if (m[single]) return [m[single]];
    return [];
  };
  return {
    ...m,
    teams:  toArr('teams',  'team'),
    tribes: toArr('tribes', 'tribe'),
    squads: toArr('squads', 'squad'),
    tags:   Array.isArray(m.tags) ? m.tags : [],
    // Drop legacy singles — clients read arrays now.
    team: undefined, tribe: undefined, squad: undefined
  };
}

function load() {
  if (!fs.existsSync(DB_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    members = (parsed.members || []).map(normaliseMember);
    nextId = parsed.nextId || (members.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1);
  } catch (e) {
    console.error('[matrix] failed to load db, starting fresh:', e.message);
  }
}

let writePending = null;
function save() {
  // Coalesce rapid writes into one actual flush
  if (writePending) return writePending;
  writePending = new Promise((resolve) => {
    setImmediate(() => {
      const tmp = DB_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ members, nextId }, null, 2));
      fs.renameSync(tmp, DB_PATH);
      writePending = null;
      resolve();
    });
  });
  return writePending;
}

load();

// Seed on first run if empty
if (members.length === 0) {
  const seed = [
    { name: 'Kate',      typeCode: 'ENFJ', identity: 'T', pcts: { EI: 18, SN: 70, TF: 61, JP: 46, AT: 85 }, team: 'Product',     tribe: '', squad: '' },
    { name: 'Dori',      typeCode: 'INFJ', identity: 'T', pcts: { EI: 75, SN: 93, TF: 65, JP: 21, AT: 76 }, team: 'Product',     tribe: '', squad: '' },
    { name: 'Aidan',     typeCode: 'ENFP', identity: 'A', pcts: { EI: 39, SN: 70, TF: 55, JP: 60, AT: 25 }, team: 'Product',     tribe: '', squad: '' },
    { name: 'Ritesh',    typeCode: 'ENFJ', identity: 'A', pcts: { EI: 34, SN: 77, TF: 75, JP: 28, AT: 31 }, team: 'Product',     tribe: '', squad: '' },
    { name: 'Timea',     typeCode: 'INFJ', identity: 'T', pcts: { EI: 55, SN: 53, TF: 53, JP: 37, AT: 58 }, team: 'Product',     tribe: '', squad: '' },
    { name: 'Alba',      typeCode: 'ENFJ', identity: 'A', pcts: { EI: 37, SN: 86, TF: 68, JP: 39, AT: 28 }, team: 'Product',     tribe: '', squad: '' },
    { name: 'Michael N', typeCode: 'INTP', identity: 'A', pcts: { EI: 66, SN: 93, TF: 39, JP: 64, AT: 12 }, team: 'Engineering', tribe: '', squad: '' },
    { name: 'Krista',    typeCode: 'ENTJ', identity: 'A', pcts: { EI: 37, SN: 64, TF: 40, JP: 36, AT: 29 }, team: 'Engineering', tribe: '', squad: '' },
    { name: 'Michael F', typeCode: 'ENFJ', identity: 'A', pcts: { EI: 29, SN: 79, TF: 53, JP: 40, AT: 29 }, team: 'Engineering', tribe: '', squad: '' },
    { name: 'Carlota',   typeCode: 'INFJ', identity: 'T', pcts: { EI: 71, SN: 67, TF: 66, JP: 28, AT: 69 }, team: 'Engineering', tribe: '', squad: '' },
    { name: 'Martin',    typeCode: 'ENFJ', identity: 'T', pcts: { EI: 48, SN: 66, TF: 71, JP: 26, AT: 58 }, team: 'Engineering', tribe: '', squad: '' },
    { name: 'Ivano',     typeCode: 'ENTJ', identity: 'A', pcts: { EI: 26, SN: 85, TF: 36, JP: 11, AT: 31 }, team: 'Engineering', tribe: '', squad: '' }
  ];
  members = seed.map(m => normaliseMember({ id: nextId++, ...m }));
  save();
  console.log(`[matrix] seeded ${seed.length} members`);
}

function findById(id) {
  const idx = members.findIndex(m => m.id === id);
  return idx >= 0 ? { idx, member: members[idx] } : null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
// Railway (and most PaaS) terminate TLS at the edge and forward HTTP to us.
// Trust the proxy so req.secure / X-Forwarded-Proto are honoured — required for
// Secure cookies to be set correctly during the Auth0 round-trip.
app.set('trust proxy', true);
app.use(express.json({ limit: '200kb' }));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Auth0 (OIDC). Enabled only when all required env vars are set.
// In local dev, leave them unset and the app runs open (no login, no user bar).
// In prod (Railway), all four are set and auth gates every non-health route.
//
// Required: AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, BASE_URL.
// Session-cookie secret is derived from AUTH0_CLIENT_SECRET via HMAC with a
// domain-separating label — stable across restarts, no extra env var.
// Bump SESSION_SECRET_VERSION to force-invalidate all sessions.
// ---------------------------------------------------------------------------
const authRequired = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'BASE_URL']
  .every(k => !!process.env[k]);

// Public
app.get('/api/health', (_req, res) => res.json({ ok: true }));

if (authRequired) {
  const SESSION_SECRET_VERSION = 'v1';
  const sessionSecret = crypto
    .createHmac('sha256', process.env.AUTH0_CLIENT_SECRET)
    .update(`matrix-app:session-cookie:${SESSION_SECRET_VERSION}`)
    .digest('hex');

  app.use(auth({
    authRequired: false,       // gated per-route below
    auth0Logout: true,
    baseURL:       process.env.BASE_URL,
    clientID:      process.env.AUTH0_CLIENT_ID,
    clientSecret:  process.env.AUTH0_CLIENT_SECRET,
    issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
    secret:        sessionSecret,
    // Namespace cookies so we don't clash with other MrQ apps sharing a parent
    // domain / Auth0 tenant. Without this, another app's /login can overwrite
    // the default `auth_verification` cookie and the /callback fails.
    session: { name: 'matrix.sid' },
    transactionCookie: { name: 'matrix.auth_verification' },
    authorizationParams: {
      response_type: 'code',
      scope: 'openid profile email'
    }
  }));

  // /api/* → 401 JSON when unauthenticated (fetch-friendly)
  app.use('/api', (req, res, next) => {
    if (req.oidc?.isAuthenticated()) return next();
    return res.status(401).json({ error: 'unauthenticated' });
  });

  // Everything else (static + SPA) → redirect to /login when unauthenticated
  app.use((req, res, next) => {
    if (req.oidc?.isAuthenticated()) return next();
    return res.oidc.login({ returnTo: req.originalUrl });
  });

  app.get('/api/me', (req, res) => {
    const u = req.oidc.user || {};
    res.json({ email: u.email, name: u.name, picture: u.picture });
  });
} else {
  console.warn('[matrix] Auth0 env vars not set — running without authentication (local dev mode)');
  app.get('/api/me', (_req, res) => res.json({ anonymous: true }));
}

app.get('/api/members', (_req, res) => res.json(members));

app.post('/api/members', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.typeCode || !b.pcts) {
    return res.status(400).json({ error: 'missing fields: name, typeCode, pcts' });
  }
  const identity = b.identity || (b.pcts.AT < 50 ? 'A' : 'T');
  const member = normaliseMember({
    id: nextId++,
    name: b.name,
    typeCode: b.typeCode,
    identity,
    pcts: { EI: b.pcts.EI, SN: b.pcts.SN, TF: b.pcts.TF, JP: b.pcts.JP, AT: b.pcts.AT },
    teams:  b.teams  ?? (b.team  ? [b.team]  : []),
    tribes: b.tribes ?? (b.tribe ? [b.tribe] : []),
    squads: b.squads ?? (b.squad ? [b.squad] : []),
    tags:   Array.isArray(b.tags) ? b.tags : []
  });
  members.push(member);
  await save();
  res.status(201).json(member);
});

app.put('/api/members/:id', async (req, res) => {
  const id = Number(req.params.id);
  const hit = findById(id);
  if (!hit) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const merged = normaliseMember({
    ...hit.member,
    name:     b.name     ?? hit.member.name,
    typeCode: b.typeCode ?? hit.member.typeCode,
    identity: b.identity ?? hit.member.identity,
    pcts:     b.pcts     ?? hit.member.pcts,
    teams:    b.teams    ?? hit.member.teams,
    tribes:   b.tribes   ?? hit.member.tribes,
    squads:   b.squads   ?? hit.member.squads,
    tags:     b.tags     ?? hit.member.tags
  });
  members[hit.idx] = merged;
  await save();
  res.json(merged);
});

app.delete('/api/members/:id', async (req, res) => {
  const id = Number(req.params.id);
  const hit = findById(id);
  if (!hit) return res.status(404).json({ error: 'not found' });
  members.splice(hit.idx, 1);
  await save();
  res.status(204).end();
});

// Bulk replace (for import/migration)
app.post('/api/members/bulk', async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected array' });
  members = req.body.map(m => normaliseMember({
    id: m.id || nextId++,
    name: m.name,
    typeCode: m.typeCode,
    identity: m.identity || (m.pcts?.AT < 50 ? 'A' : 'T'),
    pcts: m.pcts,
    teams:  m.teams  ?? (m.team  ? [m.team]  : []),
    tribes: m.tribes ?? (m.tribe ? [m.tribe] : []),
    squads: m.squads ?? (m.squad ? [m.squad] : []),
    tags:   m.tags
  }));
  nextId = Math.max(nextId, members.reduce((m, x) => Math.max(m, x.id), 0) + 1);
  await save();
  res.json(members);
});

// --- Static frontend ---
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Stale /callback hits (refreshed tab, expired transaction cookie, cookie
// clobbered by another app) throw BadRequestError from express-openid-connect.
// Instead of 500-ing the user, bounce them back to / and let the SDK start a
// fresh login round-trip.
app.use((err, req, res, next) => {
  if (err && err.name === 'BadRequestError' && req.path === '/callback') {
    console.warn(`[matrix] stale callback (${err.message}) — restarting login`);
    return res.redirect('/');
  }
  return next(err);
});

const PORT = process.env.PORT || 8080;
// Bind to loopback only in local dev so nobody on the same LAN can reach us.
// On Railway (RAILWAY_ENVIRONMENT is set) we must bind to 0.0.0.0 for the proxy.
const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
app.listen(PORT, HOST, () => console.log(`[matrix] listening on ${HOST}:${PORT}`));
