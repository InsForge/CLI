#!/usr/bin/env node
// Apply sql/*.sql to DATABASE_URL in lexical order. No psql dependency.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'sql');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env.local first.');
  process.exit(1);
}

const files = readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const f of files) {
    const sql = readFileSync(join(sqlDir, f), 'utf8');
    process.stdout.write(`▸ ${f} ... `);
    await client.query(sql);
    console.log('ok');
  }
} finally {
  await client.end();
}
