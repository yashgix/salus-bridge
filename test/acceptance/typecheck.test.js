// Type check for the whole project.
// 1. The pinned TypeScript compiler on disk is exactly the verified typescript@6.0.3 (hash of every file), so a changed
//    node_modules cannot make the check pass. 2. `tsc --noEmit -p tsconfig.json` passes for src/, test/, bench/,
//    examples/ and types/ (TypeScript must use only erasable syntax, because Node runs .ts files by stripping types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PINS = JSON.parse(fs.readFileSync('test/acceptance/typecheck-pins.json', 'utf8'));

function treeHash(dir) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) files.push([path.relative(dir, p), 'symlink']);
    else if (e.isDirectory()) walk(p);
    else files.push([path.relative(dir, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
  } };
  walk(dir);
  return { count: files.length, sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

test('pinned TypeScript compiler is unchanged', () => {
  assert.deepEqual(treeHash('node_modules/typescript'), PINS.typescript_tree);
  assert.equal(JSON.parse(fs.readFileSync('node_modules/typescript/package.json', 'utf8')).version, PINS.version);
});

test('tsc --noEmit passes', () => {
  const r = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], { encoding: 'utf8', timeout: 90000 });
  assert.equal(r.status, 0, `type errors:\n${r.stdout}${r.stderr}`);
});
