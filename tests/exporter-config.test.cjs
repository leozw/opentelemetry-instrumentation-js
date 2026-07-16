const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');

const packageRoot = path.resolve(__dirname, '..');

function runChild(source, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], {
      cwd: packageRoot,
      env: { ...process.env, OTEL_AUTO_SHUTDOWN: 'false', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test('appends signal paths when exporters.url is a base OTLP URL', async () => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    req.resume();
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end(Buffer.alloc(0));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}/otel`;
    await runChild(`
      const { initObservability } = require('./dist/index.js');
      (async () => {
        const handle = await initObservability({
          service: { serviceName: 'endpoint-test' },
          exporters: { url: ${JSON.stringify(endpoint)} },
          tracing: { enabled: true, sampling: { ratio: 1 } },
          metrics: { enabled: true, exportIntervalMillis: 60000 },
          instrumentations: false,
        });
        await handle.tracer.withSpan('endpoint-test-span', async () => undefined);
        handle.metrics.increment('endpoint_test_counter');
        await handle.forceFlush();
        await handle.shutdown();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `, {
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(paths.includes('/otel/v1/traces'), true);
  assert.equal(paths.includes('/otel/v1/metrics'), true);
});

test('honors the standard always_off sampler environment setting', async () => {
  const { stdout } = await runChild(`
    const { initObservability } = require('./dist/index.js');
    (async () => {
      const handle = await initObservability({
        service: { serviceName: 'sampling-test' },
        tracing: { enabled: true },
        metrics: { enabled: false },
        instrumentations: false,
      });
      await handle.tracer.withSpan('sampling-test-span', async (span) => {
        console.log('recording=' + span.isRecording());
      });
      await handle.shutdown();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    OTEL_TRACES_EXPORTER: 'console',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_SAMPLER: 'always_off',
  });

  assert.match(stdout, /recording=false/);
  assert.doesNotMatch(stdout, /sampling-test-span[\s\S]*traceId/);
});

test('uses a bounded default trace sampling ratio', async () => {
  const { stdout } = await runChild(`
    const { initObservability } = require('./dist/index.js');
    (async () => {
      const handle = await initObservability({
        service: { serviceName: 'default-sampling-test' },
        tracing: { enabled: true },
        metrics: { enabled: false },
        instrumentations: false,
      });
      let recording = 0;
      for (let i = 0; i < 200; i += 1) {
        await handle.tracer.withSpan('default-sampling-span', async (span) => {
          if (span.isRecording()) recording += 1;
        });
      }
      await handle.shutdown();
      console.log('recording-count=' + recording);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    OTEL_TRACES_EXPORTER: 'console',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_SAMPLER: '',
    OTEL_TRACES_SAMPLER_ARG: '',
    OTEL_TRACES_SAMPLING_RATIO: '',
  });

  const match = stdout.match(/recording-count=(\d+)/);
  assert.ok(match);
  const recording = Number(match[1]);
  assert.ok(recording > 0, `expected sampled spans, got ${recording}`);
  assert.ok(recording < 100, `expected economy sampling, got ${recording}/200`);
});

test('does not create a duplicate OpenTelemetry log export pipeline', async () => {
  const marker = 'unexpected-otel-log-export';
  const { stdout } = await runChild(`
    const { logs } = require('@opentelemetry/api-logs');
    const { initObservability } = require('./dist/index.js');
    (async () => {
      const handle = await initObservability({
        service: { serviceName: 'no-log-pipeline-test' },
        tracing: { enabled: true },
        metrics: { enabled: false },
        instrumentations: false,
      });
      logs.getLogger('test').emit({ body: ${JSON.stringify(marker)} });
      await handle.forceFlush();
      await handle.shutdown();
      console.log('completed');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `, {
    OTEL_TRACES_EXPORTER: 'console',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_SAMPLER: 'always_off',
    OTEL_LOGS_EXPORTER: 'console',
  });

  assert.match(stdout, /completed/);
  assert.doesNotMatch(stdout, new RegExp(marker));
});
