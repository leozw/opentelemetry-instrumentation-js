const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.benchmark-results');
const baselines = JSON.parse(fs.readFileSync(path.join(output, 'baselines.json')));
const receipt = { at: new Date().toISOString(), node: process.version, harness: baselines.reference,
  note: 'Original hosted harness, same 3% gate/100 connections/3s warmup/6s measurement/3 rounds; no privacy switches', variants: [] };
for (const variant of baselines.variants.filter(variant => variant.preload)) {
  const result = spawnSync(process.execPath, [path.join(output, 'reference/benchmarks/run-benchmark.cjs')], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.1',
      BENCHMARK_ENFORCE_BUDGET: 'true', BENCHMARK_PRELOAD_PATH: variant.preload },
  });
  receipt.variants.push({ name: variant.name, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr });
  fs.writeFileSync(path.join(output, 'original-harness.json'), JSON.stringify(receipt, null, 2));
  console.log(`[original-harness] ${variant.name}: status=${result.status}\n${result.stdout}`);
}
// Diagnostic only: qualification remains the enforced Benchmark budget step.
