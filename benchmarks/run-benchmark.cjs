const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createHistogram } = require('node:perf_hooks');
const autocannon = require('autocannon');

const BUDGET_PERCENT = 3;
const WARMUP_SECONDS = 3;
const MEASURE_SECONDS = 6;
const MEASURE_RUNS = 3;
const CONNECTIONS = 100;
const output = path.resolve(__dirname, '..', '.benchmark-results');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function overhead(bare, candidate) {
  if (!Number.isFinite(bare.latencyP99) || !Number.isFinite(candidate.latencyP99)) throw new Error('Missing p99, not zero latency');
  if (bare.latencyP99 > 0) return { value: (candidate.latencyP99 / bare.latencyP99 - 1) * 100, metric: 'p99-latency' };
  if (bare.requests <= 0) throw new Error('No valid throughput baseline');
  return { value: (1 - candidate.requests / bare.requests) * 100, metric: 'throughput-fallback' };
}
function latencyHistogram() {
  const histogram = createHistogram({ lowest: 1, highest: 60000000, figures: 3 });
  let invalid = 0;
  return {
    record(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 60000) { invalid++; return; }
      histogram.record(Math.max(1, Math.round(milliseconds * 1000)));
    },
    summary() {
      if (invalid || !histogram.count) throw new Error('Missing or invalid raw latency samples');
      return { count: histogram.count, p95Ms: histogram.percentile(95) / 1000, p99Ms: histogram.percentile(99) / 1000 };
    },
  };
}
function message(child, request) {
  return new Promise((resolve, reject) => {
    const done = data => { clearTimeout(timer); child.off('exit', exited); resolve(data); };
    const exited = () => { clearTimeout(timer); child.off('message', done); reject(new Error('Benchmark child exited')); };
    const timer = setTimeout(() => { child.off('message', done); child.off('exit', exited); reject(new Error('Benchmark IPC timeout')); }, 10000);
    child.once('message', done);
    child.once('exit', exited);
    if (request) child.send(request);
  });
}
function stop(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
function cleanEnvironment() {
  // Inherited preload/export/sampler settings must not change the comparison.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OTEL_|ELVEN_|NODE_OPTIONS$|LOGS_)/.test(key)));
}
async function server(variant, endpoint) {
  const profile = process.env.BENCHMARK_PROFILE_DIR;
  if (profile) fs.mkdirSync(profile, { recursive: true });
  const args = profile ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(profile)}`, `--cpu-prof-name=${variant.name}.cpuprofile`] : [];
  if (variant.preload) args.push('--require', variant.preload);
  args.push(path.join(__dirname, 'server.cjs'));
  const child = spawn(process.execPath, args, {
    env: { ...cleanEnvironment(), BENCHMARK_PORT: '0', OTEL_ZERO_CODE: variant.preload ? 'true' : 'false',
      OTEL_AUTO_SHUTDOWN: 'false', OTEL_TRACES_EXPORTER: variant.preload ? 'otlp' : 'none',
      OTEL_METRICS_EXPORTER: variant.preload ? 'otlp' : 'none', OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_TIMEOUT: '1000', OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_METRIC_EXPORT_INTERVAL: '1000',
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stderr.on('data', data => process.stderr.write(`[${variant.name}] ${data}`));
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server readiness timeout')), 10000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
      child.stdout.on('data', data => {
        const match = data.toString().match(/benchmark-server-ready:(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    return { child, port };
  } catch (error) { await stop(child); throw error; }
}
function load(port, duration) {
  return new Promise((resolve, reject) => {
    const rawLatency = latencyHistogram();
    const instance = autocannon({ url: `http://127.0.0.1:${port}`, duration, connections: CONNECTIONS, pipelining: 1 }, (error, result) => {
      if (error) return reject(error);
      try {
        const measured = rawLatency.summary();
        if (measured.count !== result.latency.totalCount) throw new Error('Raw response sample count differs from autocannon histogram');
        resolve({ latencyP99: result.latency.p99, latencyP95Ms: measured.p95Ms, latencyP99HighResolutionMs: measured.p99Ms,
          latencySampleCount: measured.count, latency: result.latency, requests: result.requests.average,
          total: result.requests.total, errors: result.errors, timeouts: result.timeouts, non2xx: result.non2xx, duration: result.duration });
      } catch (error) { reject(error); }
    });
    // Public response events preserve sub-ms measurements that the default integer-ms histogram loses.
    instance.on('response', (_client, status, _bytes, milliseconds) => {
      if (status >= 200 && status < 300) rawLatency.record(milliseconds);
    });
  });
}
async function measure(target) {
  const start = await message(target.child, 'stats');
  const collectorStart = await message(target.collector, 'stats');
  const driverStart = process.resourceUsage();
  const begin = process.hrtime.bigint();
  const result = await load(target.port, MEASURE_SECONDS);
  const elapsed = Number(process.hrtime.bigint() - begin) / 1e6;
  const end = await message(target.child, 'stats');
  const collectorEnd = await message(target.collector, 'stats');
  const driverEnd = process.resourceUsage();
  const cpu = (a, b) => b.userCPUTime + b.systemCPUTime - a.userCPUTime - a.systemCPUTime;
  return { ...result, elapsedMs: elapsed, cpuMicros: cpu(start.usage, end.usage),
    cpuPercent: cpu(start.usage, end.usage) / (elapsed * 10), rssBytesAtEnd: end.memory.rss,
    processLifetimeMaxRssKiB: end.usage.maxRSS, driverCpuMicros: cpu(driverStart, driverEnd),
    collectorCpuMicros: cpu(collectorStart.usage, collectorEnd.usage),
    exports: Object.fromEntries(Object.keys(collectorEnd.counts).map(key => [key, collectorEnd.counts[key] - collectorStart.counts[key]])) };
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const baselineFile = path.join(output, 'baselines.json');
  const baselines = process.env.BENCHMARK_COMPARE_BASELINES === 'true' ? JSON.parse(fs.readFileSync(baselineFile)) : null;
  const variants = baselines?.variants || [{ name: 'bare' }, { name: 'candidate', preload: process.env.BENCHMARK_PRELOAD_PATH || path.resolve(__dirname, '..', 'dist/preload.js') }];
  const receipt = { at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, runner: { image: process.env.ImageOS, version: process.env.ImageVersion, hosted: process.env.RUNNER_ENVIRONMENT },
    config: { budgetPercent: BUDGET_PERCENT, warmupSeconds: WARMUP_SECONDS, measureSeconds: MEASURE_SECONDS, runs: MEASURE_RUNS, connections: CONNECTIONS, pipelining: 1, sampler: 'parentbased_traceidratio', ratio: 0.1, privacy: 'default enabled', collector: 'separate process per variant', p95Measurement: 'public response event -> native HDR in microseconds, 3 significant figures; p99 gate retained', profiled: !!process.env.BENCHMARK_PROFILE_DIR },
    baselines, variants: variants.map(variant => ({ ...variant, sha256: variant.preload ? createHash('sha256').update(fs.readFileSync(variant.preload)).digest('hex') : null })), rounds: [], comparisons: {} };
  const targets = new Map();
  const children = [];
  try {
    for (const variant of variants) {
      const collector = spawn(process.execPath, [path.join(__dirname, 'collector.cjs')], { env: cleanEnvironment(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(collector);
      const { port } = await message(collector);
      const target = await server(variant, `http://127.0.0.1:${port}`);
      children.push(target.child);
      targets.set(variant.name, { ...target, collector });
      await load(target.port, WARMUP_SECONDS);
    }
    for (let round = 0; round < MEASURE_RUNS; round++) {
      const order = variants.map((_, i) => variants[(i + round) % variants.length].name);
      const results = {};
      for (const name of order) results[name] = await measure(targets.get(name));
      receipt.rounds.push({ order, results });
      console.log(`[benchmark] round=${round + 1} ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, r]) => [name, { p99: r.latencyP99, rps: r.requests, cpu: r.cpuPercent }])) )}`);
    }
    for (const variant of variants.filter(v => v.preload)) {
      const values = receipt.rounds.map(round => overhead(round.results.bare, round.results[variant.name]));
      receipt.comparisons[variant.name] = { versus: 'bare', medianOverheadPercent: median(values.map(v => v.value)), values, pass: median(values.map(v => v.value)) <= BUDGET_PERCENT };
      const p95Values = receipt.rounds.map(round => (round.results[variant.name].latencyP95Ms / round.results.bare.latencyP95Ms - 1) * 100);
      receipt.comparisons[variant.name].p95 = { medianOverheadPercent: median(p95Values), values: p95Values, pass: median(p95Values) <= BUDGET_PERCENT };
      const totals = await message(targets.get(variant.name).collector, 'stats');
      if (!totals.counts.traces || !totals.counts.metrics) throw new Error(`${variant.name}: active export not proven`);
      receipt.comparisons[variant.name].exports = totals.counts;
    }
    if (targets.has('reference')) receipt.candidateVersusReference = {
      p99DeltaPercent: median(receipt.rounds.map(r => overhead(r.results.reference, r.results.candidate).value)),
      p95DeltaPercent: median(receipt.rounds.map(r => (r.results.candidate.latencyP95Ms / r.results.reference.latencyP95Ms - 1) * 100)),
      throughputDeltaPercent: median(receipt.rounds.map(r => (r.results.candidate.requests / r.results.reference.requests - 1) * 100)),
      cpuMicrosPerRequestDeltaPercent: median(receipt.rounds.map(r => ((r.results.candidate.cpuMicros / r.results.candidate.total) / (r.results.reference.cpuMicros / r.results.reference.total) - 1) * 100)),
    };
    for (const round of receipt.rounds) for (const [name, result] of Object.entries(round.results)) {
      if (result.errors || result.timeouts || result.non2xx || result.total <= 0) throw new Error(`${name}: invalid load result`);
    }
    console.log(`[benchmark] comparisons=${JSON.stringify(receipt.comparisons)} reference=${JSON.stringify(receipt.candidateVersusReference)}; shared-host observations, not universal overhead guarantees`);
    if (process.env.BENCHMARK_ENFORCE_BUDGET === 'true' && !receipt.comparisons.candidate.pass) throw new Error(`Overhead budget exceeded: ${receipt.comparisons.candidate.medianOverheadPercent}% > ${BUDGET_PERCENT}%`);
    if (process.env.BENCHMARK_ENFORCE_BUDGET === 'true' && !receipt.comparisons.candidate.p95.pass) throw new Error(`Documented p95 overhead budget exceeded: ${receipt.comparisons.candidate.p95.medianOverheadPercent}% > ${BUDGET_PERCENT}%`);
  } catch (error) { receipt.error = error.message; throw error; }
  finally {
    await Promise.all(children.map(stop));
    fs.writeFileSync(path.join(output, process.env.BENCHMARK_PROFILE_DIR ? 'profile-receipt.json' : 'receipt.json'), JSON.stringify(receipt, null, 2));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { overhead, median, cleanEnvironment, latencyHistogram };
