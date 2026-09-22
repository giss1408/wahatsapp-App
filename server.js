#!/usr/bin/env node
/**
 * Matchday — a lightweight matchday organizer for a WhatsApp group.
 *
 * Zero runtime dependencies. State lives in a single JSON file that is written
 * atomically (temp file + rename) through a serialized queue, so concurrent
 * requests can never interleave a half-written file.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { randomUUID, timingSafeEqual, createHmac } = crypto;

// ---------------------------------------------------------------- config ----

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.MATCHDAY_DATA_DIR || path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.MATCHDAY_PASSWORD || 'matchday';
const SESSION_DAYS = Number(process.env.MATCHDAY_SESSION_DAYS || 30);
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.MATCHDAY_TRUST_PROXY || '');

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Persist a random secret so sessions survive restarts unless the operator pins one. */
function loadSecret() {
  if (process.env.MATCHDAY_SESSION_SECRET) return process.env.MATCHDAY_SESSION_SECRET;
  try {
    const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const fresh = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, fresh + '\n', { mode: 0o600 });
  return fresh;
}
const SECRET = loadSecret();

// ----------------------------------------------------------------- store ----

const DEFAULT_STORE = () => ({
  rev: 1,
  teamName: 'Team Telekom Baskets Bonn',
  season: '',
  cateringPresets: ['Coffee', 'Milk', 'Sugar', 'Tea', 'Fruit', 'Cake', 'Water', 'Soft drinks', 'Cups', 'Napkins'],
  members: [],
  events: [],
});

let store;
try {
  store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  if (!store || typeof store !== 'object' || !Array.isArray(store.events)) throw new Error('malformed store');
  store = { ...DEFAULT_STORE(), ...store };
} catch {
  store = DEFAULT_STORE();
}

// Writes are chained onto a single promise so they apply one at a time.
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(async () => {
    const tmp = `${STORE_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2));
    await fsp.rename(tmp, STORE_FILE);
  }).catch((err) => {
    console.error('[matchday] failed to persist store:', err.message);
  });
  return writeChain;
}

/** Apply a mutation, bump the revision, and flush to disk. */
function commit(fn) {
  const result = fn();
  store.rev = (store.rev || 0) + 1;
  persist();
  return result;
}

// --------------------------------------------------------------- sessions ----

function sign(value) {
  return createHmac('sha256', SECRET).update(value).digest('base64url');
}

function issueToken() {
  const payload = `${Date.now() + SESSION_MS}`;
  return `${payload}.${sign(payload)}`;
}

function tokenValid(token) {
  if (typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);
  if (mac.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  const expiry = Number(payload);
  return Number.isFinite(expiry) && expiry > Date.now();
}

function passwordMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  // Hash both sides so timingSafeEqual always sees equal-length buffers.
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// Per-IP login throttle: 10 attempts, then a cooling-off window.
const attempts = new Map();
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 10 * 60 * 1000;

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function throttleState(ip) {
  const rec = attempts.get(ip);
  if (!rec) return { locked: false, left: MAX_ATTEMPTS };
  if (Date.now() > rec.until) { attempts.delete(ip); return { locked: false, left: MAX_ATTEMPTS }; }
  return { locked: rec.count >= MAX_ATTEMPTS, left: Math.max(0, MAX_ATTEMPTS - rec.count), retryAfter: rec.until - Date.now() };
}

function noteFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  rec.until = Date.now() + LOCKOUT_MS;
  attempts.set(ip, rec);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (now > rec.until) attempts.delete(ip);
}, 60 * 1000).unref();

// ------------------------------------------------------------ validation ----

const LIMITS = { name: 60, title: 80, text: 280, note: 160 };

function str(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
}

function multiline(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/\r\n/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function dateOr(value, fallback) { return DATE_RE.test(value) ? value : fallback; }
function timeOr(value, fallback) { return TIME_RE.test(value) ? value : fallback; }
function intOr(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function findEvent(id) { return store.events.find((e) => e.id === id); }

/**
 * Register a member and return the roster's spelling of their name, so
 * "regis", "Regis" and "REGIS" all resolve to one person across every list.
 */
function canonicalMember(rawName) {
  const name = str(rawName, LIMITS.name, '');
  if (!name) return '';
  const now = new Date().toISOString();
  const existing = store.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    commit(() => { existing.lastSeen = now; });
    return existing.name;
  }
  if (store.members.length < 200) {
    commit(() => { store.members.push({ name, firstSeen: now, lastSeen: now }); });
  }
  return name;
}

function findIn(list, id) { return Array.isArray(list) ? list.find((x) => x.id === id) : undefined; }

// ---------------------------------------------------------------- routing ----

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

/** Public snapshot — the password itself never leaves the server. */
function snapshot() {
  return {
    rev: store.rev,
    teamName: store.teamName,
    season: store.season,
    cateringPresets: store.cateringPresets,
    members: store.members,
    events: store.events,
    serverTime: new Date().toISOString(),
  };
}

const api = {
  'POST /api/session': async (req, res) => {
    const ip = clientIp(req);
    const state = throttleState(ip);
    if (state.locked) {
      return send(res, 429, { error: 'Too many attempts. Try again later.', retryAfter: state.retryAfter },
        { 'retry-after': String(Math.ceil(state.retryAfter / 1000)) });
    }
    const body = await readJson(req);
    if (!passwordMatches(body.password)) {
      noteFailure(ip);
      const after = throttleState(ip);
      return send(res, 401, { error: 'Wrong password.', attemptsLeft: after.left });
    }
    const name = str(body.name, LIMITS.name, '');
    if (!name) return send(res, 400, { error: 'Your name is required.' });
    attempts.delete(ip);
    const secure = TRUST_PROXY || /^(1|true|yes)$/i.test(process.env.MATCHDAY_SECURE_COOKIE || '');
    send(res, 200, { ok: true, name: canonicalMember(name) }, {
      'set-cookie': `md_session=${issueToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure ? '; Secure' : ''}`,
    });
  },

  'DELETE /api/session': async (_req, res) => {
    send(res, 200, { ok: true }, { 'set-cookie': 'md_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  },

  'GET /api/state': async (_req, res) => send(res, 200, snapshot()),

  'POST /api/members': async (req, res) => {
    const body = await readJson(req);
    const name = str(body.name, LIMITS.name, '');
    if (!name) return send(res, 400, { error: 'A name is required.' });
    send(res, 200, { ok: true, name: canonicalMember(name), state: snapshot() });
  },

  'PATCH /api/settings': async (req, res) => {
    const body = await readJson(req);
    commit(() => {
      if ('teamName' in body) store.teamName = str(body.teamName, LIMITS.title, store.teamName);
      if ('season' in body) store.season = str(body.season, 24, '');
    });
    send(res, 200, snapshot());
  },

  'POST /api/events': async (req, res) => {
    const body = await readJson(req);
    const date = dateOr(body.date, null);
    if (!date) return send(res, 400, { error: 'A valid date (YYYY-MM-DD) is required.' });
    const kickoff = timeOr(body.kickoff, '15:00');
    const event = {
      id: randomUUID(),
      date,
      kickoff,
      opponent: str(body.opponent, LIMITS.title, 'TBD'),
      venue: str(body.venue, LIMITS.title, ''),
      notes: multiline(body.notes, LIMITS.text, ''),
      dutyFrom: timeOr(body.dutyFrom, shiftTime(kickoff, -120)),
      dutyTo: timeOr(body.dutyTo, shiftTime(kickoff, 180)),
      teardownTarget: intOr(body.teardownTarget, 4, 0, 50),
      locked: false,
      items: [],
      slots: [],
      teardown: [],
      createdAt: new Date().toISOString(),
    };
    if (Array.isArray(body.items)) {
      for (const raw of body.items.slice(0, 40)) {
        const name = str(raw && raw.name, LIMITS.name, '');
        if (name) event.items.push({ id: randomUUID(), name, qty: str(raw.qty, 24, ''), claimedBy: '', note: '', createdAt: new Date().toISOString() });
      }
    }
    commit(() => { store.events.push(event); sortEvents(); });
    send(res, 201, snapshot());
  },

  'PATCH /api/events/:id': async (req, res, { id }) => {
    const event = findEvent(id);
    if (!event) return send(res, 404, { error: 'Fixture not found.' });
    const body = await readJson(req);
    commit(() => {
      if ('date' in body) event.date = dateOr(body.date, event.date);
      if ('kickoff' in body) event.kickoff = timeOr(body.kickoff, event.kickoff);
      if ('opponent' in body) event.opponent = str(body.opponent, LIMITS.title, event.opponent);
      if ('venue' in body) event.venue = str(body.venue, LIMITS.title, '');
      if ('notes' in body) event.notes = multiline(body.notes, LIMITS.text, '');
      if ('dutyFrom' in body) event.dutyFrom = timeOr(body.dutyFrom, event.dutyFrom);
      if ('dutyTo' in body) event.dutyTo = timeOr(body.dutyTo, event.dutyTo);
      if ('teardownTarget' in body) event.teardownTarget = intOr(body.teardownTarget, event.teardownTarget, 0, 50);
      if ('locked' in body) event.locked = Boolean(body.locked);
      sortEvents();
    });
    send(res, 200, snapshot());
  },

  'DELETE /api/events/:id': async (_req, res, { id }) => {
    const idx = store.events.findIndex((e) => e.id === id);
    if (idx < 0) return send(res, 404, { error: 'Fixture not found.' });
    commit(() => { store.events.splice(idx, 1); });
    send(res, 200, snapshot());
  },

  'POST /api/events/:id/items': async (req, res, { id }) => {
    const event = findEvent(id);
    if (!event) return send(res, 404, { error: 'Fixture not found.' });
    if (event.locked) return send(res, 409, { error: 'This fixture is locked.' });
    const body = await readJson(req);
    const names = Array.isArray(body.names) ? body.names : [body.name];
    const created = [];
    for (const raw of names.slice(0, 20)) {
      const name = str(raw, LIMITS.name, '');
      if (!name) continue;
      created.push({
        id: randomUUID(),
        name,
        qty: str(body.qty, 24, ''),
        claimedBy: str(body.claimedBy, LIMITS.name, ''),
        note: str(body.note, LIMITS.note, ''),
        createdAt: new Date().toISOString(),
      });
    }
    if (!created.length) return send(res, 400, { error: 'An item name is required.' });
    if (event.items.length + created.length > 120) return send(res, 409, { error: 'Too many items on this fixture.' });
    commit(() => { event.items.push(...created); });
    send(res, 201, snapshot());
  },

  'PATCH /api/events/:id/items/:itemId': async (req, res, { id, itemId }) => {
    const event = findEvent(id);
    const item = event && findIn(event.items, itemId);
    if (!item) return send(res, 404, { error: 'Item not found.' });
    if (event.locked) return send(res, 409, { error: 'This fixture is locked.' });
    const body = await readJson(req);
    commit(() => {
      if ('name' in body) item.name = str(body.name, LIMITS.name, item.name);
      if ('qty' in body) item.qty = str(body.qty, 24, '');
      if ('note' in body) item.note = str(body.note, LIMITS.note, '');
      if ('claimedBy' in body) item.claimedBy = str(body.claimedBy, LIMITS.name, '');
    });
    send(res, 200, snapshot());
  },

  'DELETE /api/events/:id/items/:itemId': async (_req, res, { id, itemId }) => {
    const event = findEvent(id);
    if (!event) return send(res, 404, { error: 'Fixture not found.' });
    if (event.locked) return send(res, 409, { error: 'This fixture is locked.' });
    const idx = event.items.findIndex((x) => x.id === itemId);
    if (idx < 0) return send(res, 404, { error: 'Item not found.' });
    commit(() => { event.items.splice(idx, 1); });
    send(res, 200, snapshot());
  },

  'POST /api/events/:id/slots': async (req, res, { id }) => {
    const event = findEvent(id);
    if (!event) return send(res, 404, { error: 'Fixture not found.' });
    if (event.locked) return send(res, 409, { error: 'This fixture is locked.' });
    const body = await readJson(req);
    const name = str(body.name, LIMITS.name, '');
    const from = timeOr(body.from, null);
    const to = timeOr(body.to, null);
    if (!name) return send(res, 400, { error: 'Your name is required.' });
    if (!from || !to) return send(res, 400, { error: 'A valid start and end time are required.' });
    if (toMinutes(to) <= toMinutes(from)) return send(res, 400, { error: 'The end time must be after the start time.' });
    if (event.slots.length >= 120) return send(res, 409, { error: 'Too many entries on this fixture.' });
    const slot = { id: randomUUID(), name, from, to, note: str(body.note, LIMITS.note, ''), createdAt: new Date().toISOString() };
    commit(() => { event.slots.push(slot); sortSlots(event); });
    send(res, 201, snapshot());
  },

  'PATCH /api/events/:id/slots/:slotId': async (req, res, { id, slotId }) => {
    const event = findEvent(id);
    const slot = event && findIn(event.slots, slotId);
    if (!slot) return send(res, 404, { error: 'Entry not found.' });
    if (event.locked) return send(res, 409, { error: 'This fixture is locked.' });
    const body = await readJson(req);
    const from = 'from' in body ? timeOr(body.from, slot.from) : slot.from;
    const to = 'to' in body ? timeOr(body.to, slot.to) : slot.to;
    if (toMinutes(to) <= toMinutes(from)) return send(res, 400, { error: 'The end time must be after the start time.' });
    commit(() => {
      slot.from = from;
      slot.to = to;
      if ('name' in body) slot.name = str(body.name, LIMITS.name, slot.name);
      if ('note' in body) slot.note = str(body.note, LIMITS.note, '');
      sortSlots(event);
    });
    send(res, 200, snapshot());
  },

  'DELETE /api/events/:id/slots/:slotId': async (_req, res, { id, slotId }) => {
    const event = findEvent(id);
    if (!event) return send(res, 404, { error: 'Fixture not found.' });
    if (event.locked) return send(res, 409, { error: 'This fixture is locked.' });
    const idx = event.slots.findIndex((x) => x.id === slotId);
    if (idx < 0) return send(res, 404, { error: 'Entry not found.' });
    commit(() => { event.slots.splice(idx, 1); });
    send(res, 200, snapshot());
  },

  'POST /api/events/:id/teardown': async (req, res, { id }) => {
    const event = findEvent(id);
    if (!event) return send(res, 404, { error: 'Fixture not found.' });
    if (event.locked) return send(res, 409, { error: 'This fixture is locked.' });
    const body = await readJson(req);
    const name = str(body.name, LIMITS.name, '');
    if (!name) return send(res, 400, { error: 'Your name is required.' });
    const already = event.teardown.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (already) return send(res, 200, snapshot());
    if (event.teardown.length >= 60) return send(res, 409, { error: 'Too many volunteers on this fixture.' });
    commit(() => {
      event.teardown.push({ id: randomUUID(), name, note: str(body.note, LIMITS.note, ''), createdAt: new Date().toISOString() });
    });
    send(res, 201, snapshot());
  },

  'DELETE /api/events/:id/teardown/:personId': async (_req, res, { id, personId }) => {
    const event = findEvent(id);
    if (!event) return send(res, 404, { error: 'Fixture not found.' });
    if (event.locked) return send(res, 409, { error: 'This fixture is locked.' });
    const idx = event.teardown.findIndex((x) => x.id === personId);
    if (idx < 0) return send(res, 404, { error: 'Volunteer not found.' });
    commit(() => { event.teardown.splice(idx, 1); });
    send(res, 200, snapshot());
  },
};

const PUBLIC_ROUTES = new Set(['POST /api/session', 'DELETE /api/session']);

// Routes are matched by splitting on '/', so ':param' segments stay simple.
const ROUTES = Object.entries(api).map(([key, handler]) => {
  const [method, pattern] = key.split(' ');
  return { method, segments: pattern.split('/').filter(Boolean), key, handler };
});

function matchRoute(method, urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method || route.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

// ---------------------------------------------------------------- helpers ----

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function shiftTime(hhmm, deltaMinutes) {
  const total = Math.min(23 * 60 + 59, Math.max(0, toMinutes(hhmm) + deltaMinutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function sortEvents() {
  store.events.sort((a, b) => (a.date + a.kickoff).localeCompare(b.date + b.kickoff));
}

function sortSlots(event) {
  event.slots.sort((a, b) => toMinutes(a.from) - toMinutes(b.from) || a.name.localeCompare(b.name));
}

// ----------------------------------------------------------------- server ----

const server = http.createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURI(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  if (!urlPath.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, urlPath);
  }

  const found = matchRoute(req.method, urlPath);
  if (!found) return send(res, 404, { error: 'Unknown endpoint.' });

  const { route, params } = found;
  const authed = tokenValid(parseCookies(req.headers.cookie).md_session);

  if (!PUBLIC_ROUTES.has(route.key) && !authed) {
    return send(res, 401, { error: 'Not signed in.' });
  }

  // Mutations must carry a header that cross-site form posts cannot set, which
  // together with SameSite=Strict blocks CSRF.
  if (req.method !== 'GET' && req.headers['x-matchday'] !== '1') {
    return send(res, 403, { error: 'Missing request header.' });
  }

  try {
    await route.handler(req, res, params);
  } catch (err) {
    if (err instanceof SyntaxError) return send(res, 400, { error: 'Malformed JSON body.' });
    console.error('[matchday]', route.key, err);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, HOST, () => {
  const usingDefault = PASSWORD === 'matchday' && !process.env.MATCHDAY_PASSWORD;
  console.log(`\n  Matchday is running → http://localhost:${PORT}`);
  console.log(`  Data file: ${STORE_FILE}`);
  if (usingDefault) {
    console.log('\n  ⚠  Using the default password "matchday".');
    console.log('     Set MATCHDAY_PASSWORD before sharing the link.\n');
  } else {
    console.log('  Password: set via MATCHDAY_PASSWORD\n');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => writeChain.then(() => process.exit(0)));
  });
}
