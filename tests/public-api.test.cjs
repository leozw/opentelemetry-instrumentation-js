const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const { initObservability } = require('../dist/index.js');

const baseConfig = {
  runtime: 'node',
  service: {
    serviceName: 'test-service',
    serviceVersion: '2.0.0',
  },
};

async function shutdownIfStarted(handle) {
  if (!handle) return;
  if (handle.isStarted()) {
    await handle.shutdown();
  }
}

afterEach(async () => {
  process.env.OTEL_AUTO_SHUTDOWN = 'false';
  process.env.OTEL_TRACES_EXPORTER = 'none';
  process.env.OTEL_METRICS_EXPORTER = 'none';
  process.env.OTEL_TRACING_ENABLED = '';
  process.env.OTEL_METRICS_ENABLED = '';

  const handle = await initObservability(baseConfig);
  await shutdownIfStarted(handle);
});

test('returns same handle for duplicate initialization', { concurrency: 1 }, async () => {
  process.env.OTEL_AUTO_SHUTDOWN = 'false';
  process.env.OTEL_TRACES_EXPORTER = 'none';
  process.env.OTEL_METRICS_EXPORTER = 'none';

  const first = await initObservability(baseConfig);
  const second = await initObservability(baseConfig);

  assert.equal(first, second);
  assert.equal(first.isStarted(), true);

  await first.shutdown();
  assert.equal(first.isStarted(), false);
});

test('returns same handle for concurrent initialization calls', { concurrency: 1 }, async () => {
  process.env.OTEL_AUTO_SHUTDOWN = 'false';
  process.env.OTEL_TRACES_EXPORTER = 'none';
  process.env.OTEL_METRICS_EXPORTER = 'none';

  const [one, two, three] = await Promise.all([
    initObservability(baseConfig),
    initObservability(baseConfig),
    initObservability(baseConfig),
  ]);

  assert.equal(one, two);
  assert.equal(two, three);
  assert.equal(one.isStarted(), true);

  await one.shutdown();
});

test('throws explicit error for unsupported runtime', { concurrency: 1 }, async () => {
  await assert.rejects(
    initObservability({
      ...baseConfig,
      runtime: 'edge',
    }),
    /Runtime "edge" is not supported in v2/
  );
});

test('supports tracing and metrics disable flags', { concurrency: 1 }, async () => {
  process.env.OTEL_AUTO_SHUTDOWN = 'false';

  const handle = await initObservability({
    ...baseConfig,
    tracing: { enabled: false },
    metrics: { enabled: false },
    instrumentations: {
      http: { enabled: false },
      express: { enabled: false },
      fastify: { enabled: false },
      graphql: { enabled: false },
      pg: { enabled: false },
      mysql: { enabled: false },
      mongodb: { enabled: false },
      mongoose: { enabled: false },
      redis: { enabled: false },
      knex: { enabled: false },
      genericPool: { enabled: false },
      nestjs: { enabled: false },
      koa: { enabled: false },
      dns: { enabled: false },
      net: { enabled: false },
      pino: { enabled: false },
      winston: { enabled: false },
    },
  });

  assert.equal(handle.isStarted(), true);
  await handle.forceFlush();
  await handle.shutdown();
});

test('redacts db statement and hashes user id by default', { concurrency: 1 }, async () => {
  process.env.OTEL_AUTO_SHUTDOWN = 'false';
  process.env.OTEL_TRACES_EXPORTER = 'console';
  process.env.OTEL_METRICS_EXPORTER = 'none';

  const originalWrite = process.stdout.write;
  let output = '';

  process.stdout.write = function patchedWrite(chunk, encoding, callback) {
    output += chunk.toString();
    if (typeof callback === 'function') callback();
    return true;
  };

  try {
    const handle = await initObservability(baseConfig);
    await handle.tracer.withSpan('privacy-test', async (span) => {
      span.setAttribute('db.statement', 'SELECT * FROM users WHERE email = "sensitive@example.com"');
      span.setAttribute('user.id', 'user-sensitive-id-xyz-999');
    });
    await handle.forceFlush();
    await handle.shutdown();
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(output.includes('sensitive@example.com'), false);
  assert.equal(output.includes('user-sensitive-id-xyz-999'), false);
  assert.equal(output.includes('[REDACTED]'), true);
});
