#!/usr/bin/env node
/**
 * Fail fast if critical deploy files are missing before push.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'src/app.js',
  'src/server.js',
  'db/migrate.js',
  'middleware/forbidAdminOnlyCommercial.js',
  'utils/deployIdentity.js',
  'render.yaml'
];

let failed = false;
for (const rel of required) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    console.error('MISSING:', rel);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log('predeploy-backend: OK');
