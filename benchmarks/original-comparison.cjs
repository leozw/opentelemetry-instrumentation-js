const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.benchmark-results');
const baselines = JSON.parse(fs.readFileSync(path.join(output, 'baselines.json')));
const receipt = { at: new Date().toISOString(), node: process.version, harness: baselines.reference,
  note: 'Pre-optimization audited active p99 harness, same 3% gate/100 connections/3s warmup/6s measurement/3 rounds; no privacy switches. Not the historical main p95-field harness.', variants: [] };
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
if (baselines.historicalHarness) {
  const result = spawnSync(process.execPath, [baselines.historicalHarness], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', BENCHMARK_ENFORCE_BUDGET: 'true' },
  });
  fs.writeFileSync(path.join(output, 'historical-main-harness.json'), JSON.stringify({
    at: new Date().toISOString(), source: baselines.historicalSource, published: '1.0.8',
    note: 'Unmodified historical main harness: both exporters none; absent result.latency.p95 falls back to throughput. Does not qualify active capture.',
    status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
  }, null, 2));
}
// Diagnostic only: qualification remains the enforced Benchmark budget step.
