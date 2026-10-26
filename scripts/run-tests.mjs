#!/usr/bin/env node
// Runs every Node test file in the repository with the flags the project needs.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else if (/\.test\.(mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const files = ['src', 'electron', 'scripts']
  .map(directory => path.join(root, directory))
  .flatMap(directory => collect(directory))
  .sort();

if (!files.length) {
  console.error('No test files were found.');
  process.exit(1);
}

console.log(`Running ${files.length} test files…\n`);
const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...files],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
