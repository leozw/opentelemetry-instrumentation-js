const path = require('node:path');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const autocannon = require('autocannon');
const http = require('node:http');

const execFile = promisify(require('node:child_process').execFile);

const BUDGET_PERCENT = 3;
const WARMUP_SECONDS = 3;
const MEASURE_SECONDS = 6;
const MEASURE_RUNS = 3;
const CONNECTIONS = 100;

async function main() {
  const exportsReceived = { traces: 0, metrics: 0 };
  const collector = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/v1/traces') exportsReceived.traces++;
      if (req.url === '/v1/metrics') exportsReceived.metrics++;
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  const collectorEndpoint = `http://127.0.0.1:${collector.address().port}`;
  let baselineServer;
  let instrumentedServer;

  try {
    baselineServer = await startServer({ port: 0, instrumented: false, collectorEndpoint });
    instrumentedServer = await startServer({ port: 0, instrumented: true, collectorEndpoint });
    const baselinePort = baselineServer.benchmarkPort;
    const instrumentedPort = instrumentedServer.benchmarkPort;
    await runAutocannon(baselinePort, WARMUP_SECONDS);
    await runAutocannon(instrumentedPort, WARMUP_SECONDS);

    const runResults = [];
    for (let index = 0; index < MEASURE_RUNS; index++) {
      const [baseline, baselineStats] = await Promise.all([
        runAutocannon(baselinePort, MEASURE_SECONDS),
        sampleServerStats(baselineServer.pid, MEASURE_SECONDS),
      ]);
      const [instrumented, instrumentedStats] = await Promise.all([
        runAutocannon(instrumentedPort, MEASURE_SECONDS),
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
        `[benchmark][run ${index + 1}] baseline p99=${format(baseline.latencyP99)}ms | instrumented p99=${format(instrumented.latencyP99)}ms | baseline rps=${baseline.requests.toFixed(2)} | instrumented rps=${instrumented.requests.toFixed(2)} | overhead=${overheadResult.overhead.toFixed(2)}% (${overheadResult.metric})`
      );
    }

    const overheads = runResults.map((result) => result.overhead);
    const finalOverhead = median(overheads);
    const metric = runResults[0]?.metric || 'none';

    const avgBaselineCpu = average(runResults.map((result) => result.baselineStats.avgCpuPercent));
    const avgInstrumentedCpu = average(runResults.map((result) => result.instrumentedStats.avgCpuPercent));
    const baselineRss = runResults.map((result) => result.baselineStats.peakRssMb).filter(Number.isFinite);
    const instrumentedRss = runResults.map((result) => result.instrumentedStats.peakRssMb).filter(Number.isFinite);
    const peakBaselineRss = baselineRss.length ? Math.max(...baselineRss) : null;
    const peakInstrumentedRss = instrumentedRss.length ? Math.max(...instrumentedRss) : null;

    // eslint-disable-next-line no-console
    console.log(`[benchmark] final-overhead=${finalOverhead.toFixed(2)}% (${metric}, median of ${MEASURE_RUNS} runs)`);
    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] baseline avgCpu=${format(avgBaselineCpu)}% peakRss=${format(peakBaselineRss)}MB | instrumented avgCpu=${format(avgInstrumentedCpu)}% peakRss=${format(peakInstrumentedRss)}MB`
    );
    console.log(`[benchmark] local collector requests=${JSON.stringify(exportsReceived)}; shared-host observations are not universal overhead guarantees`);
    if (!exportsReceived.traces || !exportsReceived.metrics) throw new Error('Benchmark did not prove active trace and metric export');

    const enforceBudget = process.env.BENCHMARK_ENFORCE_BUDGET === 'true';
    if (enforceBudget && finalOverhead > BUDGET_PERCENT) {
      throw new Error(
        `[benchmark] Overhead budget exceeded: ${finalOverhead.toFixed(2)}% > ${BUDGET_PERCENT}%`
      );
    }
  } finally {
    await Promise.all([baselineServer, instrumentedServer].filter(Boolean).map(stopServer));
    collector.closeAllConnections();
    await new Promise(resolve => collector.close(resolve));
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
          latencyP99: Number.isFinite(result.latency.p99) ? result.latency.p99 : null,
          requests: Number(result.requests.average || 0),
        });
      }
    );

    instance.on('error', reject);
  });
}

function startServer({ port, instrumented, collectorEndpoint }) {
  return new Promise((resolve, reject) => {
    const serverFile = path.resolve(__dirname, 'server.cjs');
    const preloadFile = process.env.BENCHMARK_PRELOAD_PATH || path.resolve(__dirname, '..', 'dist', 'preload.js');

    const env = {
      ...process.env,
      BENCHMARK_PORT: String(port),
      OTEL_AUTO_SHUTDOWN: 'false',
      OTEL_ZERO_CODE: instrumented ? 'true' : 'false',
      OTEL_TRACES_EXPORTER: instrumented ? 'otlp' : 'none',
      OTEL_METRICS_EXPORTER: instrumented ? 'otlp' : 'none',
      OTEL_EXPORTER_OTLP_ENDPOINT: collectorEndpoint,
      OTEL_EXPORTER_OTLP_TIMEOUT: '1000',
      OTEL_BSP_SCHEDULE_DELAY: '100',
      OTEL_METRIC_EXPORT_INTERVAL: '1000',
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
      const ready = value.match(/benchmark-server-ready:(\d+)/);
      if (ready) {
        clearTimeout(timeout);
        child.benchmarkPort = Number(ready[1]);
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
      avgCpuPercent: null,
      peakRssMb: null,
      samples: 0,
    };
  }

  const totalCpu = samples.reduce((acc, sample) => acc + sample.cpuPercent, 0);
  const peakRssKb = samples.reduce((max, sample) => Math.max(max, sample.rssKb), 0);

  return {
    avgCpuPercent: totalCpu / samples.length,
    peakRssMb: peakRssKb / 1024,
    samples: samples.length,
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
  if (baseline.latencyP99 > 0 && Number.isFinite(instrumented.latencyP99)) {
    return {
      overhead: ((instrumented.latencyP99 - baseline.latencyP99) / baseline.latencyP99) * 100,
      metric: 'p99-latency',
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
  const known = values.filter(Number.isFinite);
  if (known.length === 0) return null;
  return known.reduce((acc, value) => acc + value, 0) / known.length;
}

function format(value) { return Number.isFinite(value) ? value.toFixed(2) : 'UNKNOWN'; }

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
