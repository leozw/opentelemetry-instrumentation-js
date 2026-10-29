const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');

test('failOpen false propagates component startup failure; true is explicitly unstarted', async () => {
  const { initObservability } = require('../dist/index.js');
  const config = { failOpen: false, autoShutdown: false, service: { serviceName: 'failure', serviceVersion: '1' }, exporters: { url: 'not-a-url' }, instrumentations: false, metrics: { enabled: false }, tracing: { enabled: true } };
  await assert.rejects(initObservability(config), /Invalid URL/);
  const fallback = await initObservability({ ...config, failOpen: true });
  assert.equal(fallback.isStarted(), false);
  assert.equal(fallback.tracer.startSpan('ignored').isRecording(), false);
  fallback.metrics.increment('ignored');
  await fallback.forceFlush();
  await fallback.shutdown();
});

test('CJS and ESM share initialization; stale handles cannot stop a replacement', async () => {
  const cjs = require('../dist/index.js');
  const esm = await import('../dist/index.mjs');
  const config = { autoShutdown: false, service: { serviceName: 'shared', serviceVersion: '1' }, tracing: { enabled: false }, metrics: { enabled: false } };
  const [a, b] = await Promise.all([cjs.initObservability(config), esm.initObservability(config)]);
  assert.equal(a, b);
  assert.equal(cjs.tracer, esm.tracer);
  await a.shutdown();
  const replacement = await esm.initObservability(config);
  assert.equal(a.isStarted(), false);
  await a.shutdown();
  assert.equal(replacement.isStarted(), true);
  await replacement.shutdown();
});

test('metric name retention is bounded independently of attribute cardinality', () => {
  const { MetricFacade } = require('../dist/index.js');
  const metrics = new MetricFacade('bounded');
  for (let i = 0; i < 10000; i++) metrics.increment(`request_${i}`);
  assert.equal(metrics.getDroppedInstruments(), 10000 - 128);
  assert.equal(metrics.getCounter('request_0'), metrics.getCounter('request_0'));
  assert.doesNotThrow(() => metrics.recordHistogram('overflow', 1));
});

test('redaction covers events and links, and SDK globals are not started twice', () => {
  const result = spawnSync(process.execPath, ['-e', `
    (async () => {
      const { initObservability } = require('./dist/index.js');
      const h = await initObservability({autoShutdown:false,service:{serviceName:'privacy',serviceVersion:'1'},metrics:{enabled:false},instrumentations:false,tracing:{sampling:{ratio:1}}});
      const span = h.tracer.startSpan('privacy', { links: [{ context: { traceId:'12345678901234567890123456789012',spanId:'1234567890123456',traceFlags:1}, attributes: { 'db.statement':'link-secret' } }] });
      span.setAttribute('db.statement','span-secret');
      span.setAttribute('db.user','db-user-secret');
      span.setAttribute('url.full', 'https://private-url-user:private-url-password@example.test/path?token=private-query-value');
      span.addEvent('event', { 'db.query.text':'event-secret','user.id':'user-secret' });
      span.end();
      const oversized = h.tracer.startSpan('oversized-array');
      oversized.setAttribute('huge', Array(1000).fill('x'));
      oversized.end();
      const strings = h.tracer.startSpan('bounded-string');
      strings.setAttribute('long', 'z'.repeat(10000));
      if (strings.attributes.long.length !== 4096) throw new Error('attribute string unbounded');
      strings.end();
      await h.forceFlush();
      if (span.attributes['db.statement'] !== 'span-secret') throw new Error('original mutated');
      await h.shutdown();
    })().catch(e=>{console.error(e);process.exitCode=1});
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000, env: { ...process.env, OTEL_TRACES_EXPORTER: 'console', OTEL_METRICS_EXPORTER: 'none' } });
  assert.equal(result.status, 0, result.stderr);
  for (const secret of ['span-secret','link-secret','event-secret','db-user-secret','user-secret','private-url-user','private-url-password','private-query-value']) assert.equal(result.stdout.includes(secret), false, secret);
  assert.ok(result.stdout.includes('[REDACTED]'));
  assert.equal(result.stdout.includes('oversized-array'), false);
  assert.ok(result.stdout.includes('bounded-string'));
});

test('shutdown removes only its handlers and preserves an application signal exit', () => {
  const result = spawnSync(process.execPath, ['-e', `
    (async()=>{
      const {initObservability}=require('./dist/index.js');
      process.on('SIGTERM',()=>{setTimeout(()=>process.exit(23),50)});
      await initObservability({service:{serviceName:'signals',serviceVersion:'1'},metrics:{enabled:false},instrumentations:false});
      process.kill(process.pid,'SIGTERM');
      setTimeout(()=>process.exit(99),1000);
    })();
  `], { cwd: require('node:path').resolve(__dirname, '..'), timeout: 5000, env: { ...process.env, OTEL_TRACES_EXPORTER: 'console' } });
  assert.equal(result.status, 23, result.stderr?.toString());
});
