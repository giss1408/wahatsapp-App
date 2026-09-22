'use strict';
/**
 * Storage backends for the single JSON document that is all of Matchday's state.
 *
 * Two interchangeable backends sit behind one interface:
 *
 *   files     — ./data/store.json + ./data/secret.key. The default; nothing to
 *               set up, ideal for running locally.
 *   postgres  — the same document in one row, used when DATABASE_URL is set.
 *
 * The second one exists because hosts like Render rebuild the container on every
 * restart: a free instance sleeps after 15 minutes of silence and wakes up with
 * a pristine filesystem, so anything written under ./data is gone. Pointing
 * DATABASE_URL at a managed Postgres moves the state outside the container
 * without changing anything about how the app uses it.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DOC_KEY = 'store';
const SECRET_KEY = 'secret';

// ------------------------------------------------------------------ files ----

function fileStorage(dataDir) {
  const storeFile = path.join(dataDir, 'store.json');
  const secretFile = path.join(dataDir, 'secret.key');

  return {
    kind: 'files',
    describe: () => storeFile,
    ephemeralWarning:
      'State lives on the local filesystem. On a host that rebuilds the container ' +
      'on restart (Render free tier, Fly machines, Heroku), it will not survive a ' +
      'sleep or a deploy — set DATABASE_URL to keep it.',

    async init() {
      await fsp.mkdir(dataDir, { recursive: true });
    },

    async readDoc() {
      try {
        return JSON.parse(await fsp.readFile(storeFile, 'utf8'));
      } catch {
        return null; // first run, or a file we cannot parse
      }
    },

    // Written atomically (temp file + rename) so a crash mid-write cannot leave
    // a half-serialized document behind.
    async writeDoc(doc) {
      const tmp = `${storeFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(doc, null, 2));
      await fsp.rename(tmp, storeFile);
    },

    async readSecret() {
      try {
        return (await fsp.readFile(secretFile, 'utf8')).trim() || null;
      } catch {
        return null;
      }
    },

    async writeSecret(secret) {
      await fsp.writeFile(secretFile, secret + '\n', { mode: 0o600 });
    },

    async close() {},
  };
}

// --------------------------------------------------------------- postgres ----

function postgresStorage(url) {
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch {
    throw new Error('DATABASE_URL is set but the "pg" package is missing — run `npm install`.');
  }

  // Managed Postgres (Neon, Supabase, Render) presents a publicly trusted
  // certificate, so the CA check stays on. Only a local server opts out.
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(url);
  const sslDisabled = isLocal || /[?&]sslmode=(disable|allow)\b/.test(url);

  const pool = new Pool({
    connectionString: url,
    ssl: sslDisabled ? false : { rejectUnauthorized: true },
    max: 3,
    // Neon's free compute suspends when idle; keep the first query patient.
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on('error', (err) => console.error('[matchday] idle postgres client error:', err.message));

  async function readValue(key) {
    const { rows } = await pool.query('SELECT doc FROM matchday_state WHERE key = $1', [key]);
    return rows.length ? rows[0].doc : null;
  }

  async function writeValue(key, value) {
    await pool.query(
      `INSERT INTO matchday_state (key, doc, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET doc = excluded.doc, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  return {
    kind: 'postgres',
    describe: () => {
      try {
        const parsed = new URL(url);
        return `postgres://${parsed.host}${parsed.pathname}`; // never log credentials
      } catch {
        return 'postgres';
      }
    },
    ephemeralWarning: '',

    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS matchday_state (
          key        text PRIMARY KEY,
          doc        jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
    },

    readDoc: () => readValue(DOC_KEY),
    writeDoc: (doc) => writeValue(DOC_KEY, doc),

    async readSecret() {
      const row = await readValue(SECRET_KEY);
      return row && typeof row.secret === 'string' ? row.secret : null;
    },

    writeSecret: (secret) => writeValue(SECRET_KEY, { secret }),

    close: () => pool.end(),
  };
}

// ----------------------------------------------------------------------------

/** Pick a backend from the environment. DATABASE_URL wins when present. */
function createStorage({ dataDir, databaseUrl }) {
  return databaseUrl ? postgresStorage(databaseUrl) : fileStorage(dataDir);
}

module.exports = { createStorage, fileStorage, postgresStorage };
