const path = require('node:path');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const autocannon = require('autocannon');

const execFile = promisify(require('node:child_process').execFile);

const BASELINE_PORT = 4400;
const INSTRUMENTED_PORT = 4401;
const BUDGET_PERCENT = 3;
const WARMUP_SECONDS = 3;
const MEASURE_SECONDS = 6;
const MEASURE_RUNS = 3;
const CONNECTIONS = 100;

async function main() {
  const baselineServer = await startServer({ port: BASELINE_PORT, instrumented: false });
  const instrumentedServer = await startServer({ port: INSTRUMENTED_PORT, instrumented: true });

  try {
    await runAutocannon(BASELINE_PORT, WARMUP_SECONDS);
    await runAutocannon(INSTRUMENTED_PORT, WARMUP_SECONDS);

    const runResults = [];
    for (let index = 0; index < MEASURE_RUNS; index++) {
      const [baseline, baselineStats] = await Promise.all([
        runAutocannon(BASELINE_PORT, MEASURE_SECONDS),
        sampleServerStats(baselineServer.pid, MEASURE_SECONDS),
      ]);
      const [instrumented, instrumentedStats] = await Promise.all([
        runAutocannon(INSTRUMENTED_PORT, MEASURE_SECONDS),
        sampleServerStats(instrumentedServer.pid, MEASURE_SECONDS),
      ]);
      const overheadResult = computeOverhead(baseline, instrumented);

      runResults.push({
        baseline,
        instrumented,
        baselineStats,
        instrumentedStats,
        overhead: overheadResult.overhead,
        metric: overheadResult.metric,
      });

      // eslint-disable-next-line no-console
      console.log(
        `[benchmark][run ${index + 1}] baseline p95=${baseline.latencyP95.toFixed(2)}ms | instrumented p95=${instrumented.latencyP95.toFixed(2)}ms | baseline rps=${baseline.requests.toFixed(2)} | instrumented rps=${instrumented.requests.toFixed(2)} | overhead=${overheadResult.overhead.toFixed(2)}% (${overheadResult.metric})`
      );
    }

    const overheads = runResults.map((result) => result.overhead);
    const finalOverhead = median(overheads);
    const metric = runResults[0]?.metric || 'none';

    const avgBaselineCpu = average(runResults.map((result) => result.baselineStats.avgCpuPercent));
    const avgInstrumentedCpu = average(runResults.map((result) => result.instrumentedStats.avgCpuPercent));
    const peakBaselineRss = Math.max(...runResults.map((result) => result.baselineStats.peakRssMb));
    const peakInstrumentedRss = Math.max(...runResults.map((result) => result.instrumentedStats.peakRssMb));

    // eslint-disable-next-line no-console
    console.log(`[benchmark] final-overhead=${finalOverhead.toFixed(2)}% (${metric}, median of ${MEASURE_RUNS} runs)`);
    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] baseline avgCpu=${avgBaselineCpu.toFixed(2)}% peakRss=${peakBaselineRss.toFixed(2)}MB | instrumented avgCpu=${avgInstrumentedCpu.toFixed(2)}% peakRss=${peakInstrumentedRss.toFixed(2)}MB`
    );

    const enforceBudget = process.env.BENCHMARK_ENFORCE_BUDGET === 'true';
    if (enforceBudget && finalOverhead > BUDGET_PERCENT) {
      throw new Error(
        `[benchmark] Overhead budget exceeded: ${finalOverhead.toFixed(2)}% > ${BUDGET_PERCENT}%`
      );
    }
  } finally {
    await Promise.all([stopServer(baselineServer), stopServer(instrumentedServer)]);
  }
}

function runAutocannon(port, duration) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url: `http://127.0.0.1:${port}`,
        duration,
        connections: CONNECTIONS,
        pipelining: 1,
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        resolve({
          latencyP95: Number(result.latency.p95 || 0),
          requests: Number(result.requests.average || 0),
        });
      }
    );

    instance.on('error', reject);
  });
}

function startServer({ port, instrumented }) {
  return new Promise((resolve, reject) => {
    const serverFile = path.resolve(__dirname, 'server.cjs');
    const preloadFile = path.resolve(__dirname, '..', 'dist', 'preload.js');

    const env = {
      ...process.env,
      BENCHMARK_PORT: String(port),
      OTEL_AUTO_SHUTDOWN: 'false',
      OTEL_ZERO_CODE: instrumented ? 'true' : 'false',
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
      NODE_OPTIONS: instrumented
        ? `${process.env.NODE_OPTIONS || ''} --require ${preloadFile}`.trim()
        : process.env.NODE_OPTIONS || '',
    };

    const child = spawn(process.execPath, [serverFile], {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`[benchmark] Timeout starting server on port ${port}`));
    }, 10000);

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.stdout.on('data', (chunk) => {
      const value = chunk.toString();
      if (value.includes(`benchmark-server-ready:${port}`)) {
        clearTimeout(timeout);
        resolve(child);
      }
    });

    child.stderr.on('data', (chunk) => {
      const value = chunk.toString().trim();
      if (value) {
        // eslint-disable-next-line no-console
        console.error(`[benchmark][server:${port}] ${value}`);
      }
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

async function sampleServerStats(pid, durationSeconds) {
  const samples = [];
  const startedAt = Date.now();
  const intervalMs = 1000;

  while (Date.now() - startedAt < durationSeconds * 1000) {
    const sample = await readProcessSample(pid);
    if (sample) {
      samples.push(sample);
    }
    await sleep(intervalMs);
  }

  if (samples.length === 0) {
    return {
      avgCpuPercent: 0,
      peakRssMb: 0,
    };
  }

  const totalCpu = samples.reduce((acc, sample) => acc + sample.cpuPercent, 0);
  const peakRssKb = samples.reduce((max, sample) => Math.max(max, sample.rssKb), 0);

  return {
    avgCpuPercent: totalCpu / samples.length,
    peakRssMb: peakRssKb / 1024,
  };
}

async function readProcessSample(pid) {
  try {
    const { stdout } = await execFile('ps', ['-o', '%cpu=', '-o', 'rss=', '-p', String(pid)]);
    const values = stdout.trim().split(/\s+/);
    if (values.length < 2) return null;

    const cpuPercent = Number(values[0]);
    const rssKb = Number(values[1]);

    if (Number.isNaN(cpuPercent) || Number.isNaN(rssKb)) return null;
    return { cpuPercent, rssKb };
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeOverhead(baseline, instrumented) {
  if (baseline.latencyP95 > 0) {
    return {
      overhead: ((instrumented.latencyP95 - baseline.latencyP95) / baseline.latencyP95) * 100,
      metric: 'p95-latency',
    };
  }

  if (baseline.requests > 0) {
    return {
      overhead: ((baseline.requests - instrumented.requests) / baseline.requests) * 100,
      metric: 'throughput-drop',
    };
  }

  return { overhead: 0, metric: 'none' };
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error.message || error);
  process.exit(1);
});
