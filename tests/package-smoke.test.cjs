const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '..');

test('CJS smoke import works', { concurrency: 1 }, async () => {
  const command = [
    'const lib = require("./dist/index.js");',
    'if (typeof lib.initObservability !== "function") process.exit(1);',
  ].join(' ');

  await execFileAsync(process.execPath, ['-e', command], { cwd: repoRoot });
});

test('ESM smoke import works', { concurrency: 1 }, async () => {
  const command = [
    'import("./dist/index.mjs").then((lib) => {',
    '  if (typeof lib.initObservability !== "function") process.exit(1);',
    '});',
  ].join(' ');

  const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
    cwd: repoRoot,
  });

  assert.equal(result.stderr, '');
});
