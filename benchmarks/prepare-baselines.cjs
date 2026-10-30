const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.benchmark-results');
const reference = '5f98ebe5b17a32fa7f68747f77f810407d78e471';
fs.mkdirSync(output, { recursive: true });
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
const referenceDir = path.join(output, 'reference');
fs.mkdirSync(referenceDir, { recursive: true });
const archive = path.join(output, 'reference.tar');
run('git', ['archive', '--format=tar', `--output=${archive}`, reference], root);
run('tar', ['-xf', archive, '-C', referenceDir], root);
run('npm', ['ci', '--no-audit', '--no-fund'], referenceDir);
run('npm', ['run', 'build'], referenceDir);
const publishedDir = path.join(output, 'published');
fs.mkdirSync(publishedDir, { recursive: true });
fs.writeFileSync(path.join(publishedDir, 'package.json'), JSON.stringify({ name: 'benchmark-published', private: true }));
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', 'elven-opentelemetry-instrumentation-js@1.0.8'], publishedDir);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const published = path.join(publishedDir, 'node_modules/elven-opentelemetry-instrumentation-js/dist/preload.js');
const historicalSource = '077c72e1954aef5315325431a4d55cd10a72f90e';
const historicalDir = path.join(output, 'historical-main');
fs.mkdirSync(path.join(historicalDir, 'benchmarks'), { recursive: true });
for (const file of ['run-benchmark.cjs', 'server.cjs']) {
  fs.writeFileSync(path.join(historicalDir, 'benchmarks', file), run('git', ['show', `${historicalSource}:benchmarks/${file}`], root));
}
fs.cpSync(path.dirname(published), path.join(historicalDir, 'dist'), { recursive: true });
if (!fs.existsSync(path.join(historicalDir, 'node_modules'))) fs.symlinkSync(path.join(publishedDir, 'node_modules'), path.join(historicalDir, 'node_modules'), 'dir');
fs.writeFileSync(path.join(output, 'baselines.json'), JSON.stringify({
  reference, published: '1.0.8', historicalSource, historicalHarness: path.join(historicalDir, 'benchmarks/run-benchmark.cjs'), at: new Date().toISOString(),
  hashes: { referencePreload: hash(path.join(referenceDir, 'dist/preload.js')), referenceLock: hash(path.join(referenceDir, 'package-lock.json')), publishedPreload: hash(published), publishedResolvedLock: hash(path.join(publishedDir, 'package-lock.json')) },
  variants: [ { name: 'bare' }, { name: 'published', preload: published },
    { name: 'reference', preload: path.join(referenceDir, 'dist/preload.js') },
    { name: 'candidate', preload: path.join(root, 'dist/preload.js') } ],
}, null, 2));
console.log('Prepared immutable audited reference and fresh resolved published baseline');
