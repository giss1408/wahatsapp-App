#!/usr/bin/env node
/**
 * One-shot copy of local state (./data/store.json) into the Postgres backend.
 *
 *   DATABASE_URL='postgres://…' npm run migrate
 *
 * Refuses to clobber an existing remote document unless --force is passed, so
 * running it twice cannot wipe what the group has entered since.
 */
'use strict';

const path = require('node:path');
const { fileStorage, postgresStorage } = require('./storage');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const force = process.argv.includes('--force');
  const dataDir = process.env.MATCHDAY_DATA_DIR || path.join(__dirname, 'data');

  const from = fileStorage(dataDir);
  const to = postgresStorage(url);
  await to.init();

  const local = await from.readDoc();
  if (!local) throw new Error(`no local state found in ${dataDir}`);

  const remote = await to.readDoc();
  if (remote && !force) {
    console.error(
      `Refusing to overwrite: ${to.describe()} already holds state ` +
      `(rev ${remote.rev}, ${(remote.events || []).length} fixture(s)).\n` +
      'Pass --force if you are sure the local copy should win.',
    );
    await to.close();
    process.exit(1);
  }

  await to.writeDoc(local);
  console.log(`Copied rev ${local.rev}, ${(local.events || []).length} fixture(s), ` +
    `${(local.members || []).length} member(s) → ${to.describe()}`);

  // The signing key moves too, so existing sign-ins survive the switch.
  const secret = await from.readSecret();
  if (secret && (force || !(await to.readSecret()))) {
    await to.writeSecret(secret);
    console.log('Copied the session signing key.');
  }

  await to.close();
}

main().catch((err) => {
  console.error(`migrate: ${err.message}`);
  process.exit(1);
});
