'use strict';
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const api = require('@opentelemetry/api');
const { logs } = require('@opentelemetry/api-logs');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
const sdk = require('../dist/index.js');
const handles = new Set();
const savedExport = ConsoleSpanExporter.prototype.export;
const envKeys = ['OTEL_TRACES_EXPORTER', 'OTEL_METRICS_EXPORTER', 'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_TRACES_SAMPLER', 'OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let spans;
const config = () => ({ service: { serviceName: 'provider-controls', serviceVersion: '2.0.0' },
  autoShutdown: false, instrumentations: false, tracing: { enabled: true, sampling: { ratio: 1 } }, metrics: { enabled: false } });
async function init(input = config()) { const handle = await sdk.initObservability(input); handles.add(handle); return handle; }
beforeEach(() => {
  spans = []; process.env.OTEL_TRACES_EXPORTER = 'console'; process.env.OTEL_METRICS_EXPORTER = 'none';
  ConsoleSpanExporter.prototype.export = function (items, done) { spans.push(...items); done({ code: 0 }); };
});
afterEach(async () => {
  try { for (const handle of handles) await handle.shutdown(); }
  finally {
    handles.clear(); ConsoleSpanExporter.prototype.export = savedExport;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
    // These globals belong to this isolated test process. Product teardown must
    // not perform these unconditional application/test-owner operations.
    api.trace.disable(); api.metrics.disable(); logs.disable(); api.context.disable(); api.propagation.disable();
  }
});

test('actual root trace-only mode records a healthy span without borrowing the foreign disabled meter', async () => {
  let meterCalls = 0;
  const foreignMeter = { getMeter() { meterCalls++; return api.createNoopMeter(); } };
  assert.equal(api.metrics.setGlobalMeterProvider(foreignMeter), true);
  const handle = await init();
  assert.equal(handle.tracer.withSpan('ordinary', span => span.isRecording()), true);
  handle.metrics.increment('ordinary_total'); await handle.forceFlush(); await handle.shutdown();
  assert.equal(spans.length, 1); assert.equal(spans[0].name, 'ordinary');
  assert.equal(meterCalls, 0); assert.equal(api.metrics.getMeterProvider(), foreignMeter);
});

test('actual root metrics-enabled/no-exporter mode keeps disabled tracing isolated from a foreign tracer', async () => {
  let calls = 0;
  const foreign = { getTracer() { calls++; return new api.ProxyTracerProvider().getTracer('foreign'); } };
  assert.equal(api.trace.setGlobalTracerProvider(foreign), true);
  const before = api.trace.getTracerProvider(), input = config();
  input.tracing.enabled = false; input.metrics.enabled = true;
  const handle = await init(input);
  assert.equal(handle.isStarted(), true);
  assert.equal(handle.tracer.withSpan('ordinary', span => span.isRecording()), false);
  const original = new Error('synthetic business');
  assert.throws(() => handle.tracer.withSpan('business', () => { throw original; }), error => error === original);
  handle.metrics.increment('ordinary_total'); await handle.shutdown();
  assert.equal(calls, 0); assert.equal(api.trace.getTracerProvider(), before);
  assert.equal(spans.length, 0); // Not a positive metrics-delivery qualification.
});

test('actual foreign logger identity and shutdown remain untouched across trace startup/shutdown', async () => {
  let stops = 0, requests = 0;
  const foreign = { getLogger() { requests++; return { emit() {} }; }, async shutdown() { stops++; } };
  assert.equal(logs.setGlobalLoggerProvider(foreign), foreign);
  const handle = await init(); handle.tracer.withSpan('ordinary', () => 1);
  await handle.forceFlush(); await handle.shutdown();
  assert.equal(logs.getLoggerProvider(), foreign); assert.equal(stops, 0);
  assert.equal(requests, 0); // This case explicitly disables all instrumentations.
  assert.equal(spans.length, 1);
});

test('actual foreign context and propagator survive successful startup, shutdown and reinitialization', async () => {
  let disables = 0;
  const manager = new AsyncLocalStorageContextManager().enable();
  const originalDisable = manager.disable.bind(manager);
  manager.disable = () => { disables++; return originalDisable(); };
  assert.equal(api.context.setGlobalContextManager(manager), true);
  const key = api.createContextKey('synthetic-owner');
  const foreign = {
    fields: () => ['x-synthetic-owner'],
    inject(_ctx, carrier, setter) { setter.set(carrier, 'x-synthetic-owner', 'ordinary'); },
    extract(ctx) { return ctx; },
  };
  assert.equal(api.propagation.setGlobalPropagator(foreign), true);
  for (let index = 0; index < 2; index++) {
    const handle = await init();
    api.context.with(api.ROOT_CONTEXT.setValue(key, 7), () => assert.equal(api.context.active().getValue(key), 7));
    const carrier = {}; api.propagation.inject(api.ROOT_CONTEXT, carrier);
    assert.deepEqual(carrier, { 'x-synthetic-owner': 'ordinary' });
    handle.tracer.withSpan('ordinary', () => 1); await handle.forceFlush(); await handle.shutdown();
    assert.equal(disables, 0); assert.deepEqual(api.propagation.fields(), ['x-synthetic-owner']);
  }
  assert.equal(spans.length, 2);
});

test('actual lazy W3C trace-context/baggage bootstrap remains available after owned pipeline shutdown', async () => {
  const handle = await init();
  const spanContext = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: api.TraceFlags.SAMPLED };
  let ctx = api.trace.setSpanContext(api.ROOT_CONTEXT, spanContext);
  ctx = api.propagation.setBaggage(ctx, api.propagation.createBaggage({ ordinary: { value: 'value' } }));
  const before = {}; api.propagation.inject(ctx, before);
  assert.equal(before.traceparent, `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`);
  assert.equal(before.baggage, 'ordinary=value');
  await handle.shutdown();
  const after = {}; api.propagation.inject(ctx, after); assert.deepEqual(after, before);
  const extracted = api.propagation.extract(api.ROOT_CONTEXT, after);
  assert.equal(api.trace.getSpanContext(extracted).traceId, spanContext.traceId);
  assert.equal(api.propagation.getBaggage(extracted).getEntry('ordinary').value, 'value');
});

test('actual foreign trace registration rejection rolls back, then a new initialization can record', async () => {
  const foreign = { getTracer: () => new api.ProxyTracerProvider().getTracer('foreign') };
  assert.equal(api.trace.setGlobalTracerProvider(foreign), true);
  const before = api.trace.getTracerProvider();
  await assert.rejects(sdk.initObservability(config()), /could not register its global provider/);
  assert.equal(api.trace.getTracerProvider(), before);
  api.trace.disable();
  const handle = await init(); handle.tracer.withSpan('ordinary', () => 1);
  await handle.forceFlush(); await handle.shutdown(); assert.equal(spans.length, 1);
});

test('actual replacement global tracer survives shutdown of the old owned pipeline', async () => {
  const handle = await init(); handle.tracer.withSpan('ordinary', () => 1); await handle.forceFlush();
  api.trace.disable();
  const replacement = { getTracer: () => new api.ProxyTracerProvider().getTracer('replacement') };
  assert.equal(api.trace.setGlobalTracerProvider(replacement), true);
  const before = api.trace.getTracerProvider();
  await handle.shutdown(); assert.equal(api.trace.getTracerProvider(), before); assert.equal(spans.length, 1);
});

test('actual explicit Resource preserves host/process/runtime/service fields and existing privacy without enabling env detection', async () => {
  process.env.OTEL_RESOURCE_ATTRIBUTES = 'synthetic.env.attribute=must-not-be-imported';
  const input = config(); input.service.attributes = { route: '/ordinary', 'db.statement': 'SYNTHETIC_SQL', 'user.id': 'SYNTHETIC_USER' };
  const handle = await init(input); handle.tracer.withSpan('ordinary', () => 1); await handle.forceFlush();
  assert.equal(spans.length, 1);
  const attrs = spans[0].resource.attributes;
  assert.equal(attrs['service.name'], 'provider-controls'); assert.equal(attrs['service.version'], '2.0.0');
  assert.equal(attrs['host.name'], require('node:os').hostname()); assert.equal(attrs['process.pid'], process.pid);
  assert.equal(attrs['process.runtime.name'], 'nodejs'); assert.equal(attrs['process.runtime.version'], process.version);
  assert.equal(attrs.route, '/ordinary'); assert.equal(attrs['db.statement'], '[REDACTED]');
  assert.match(attrs['user.id'], /^[a-f0-9]{16}$/); assert.equal(attrs['synthetic.env.attribute'], undefined);
});

test('actual ParentBased sampling honors an unsampled parent and preserves ordinary recording scope metadata', async () => {
  const handle = await init();
  const parent = api.trace.setSpanContext(api.ROOT_CONTEXT, {
    traceId: '3'.repeat(32), spanId: '4'.repeat(16), traceFlags: api.TraceFlags.NONE, isRemote: true,
  });
  api.context.with(parent, () => assert.equal(handle.tracer.withSpan('parent-off', span => span.isRecording()), false));
  assert.equal(handle.tracer.withSpan('ordinary', span => span.isRecording()), true);
  await handle.forceFlush();
  assert.equal(spans.length, 1); assert.equal(spans[0].name, 'ordinary');
  assert.equal(spans[0].instrumentationScope.name, 'provider-controls');
  assert.equal(spans[0].instrumentationScope.version, '2.0.0');
});

test('actual direct provider does not evaluate shim env defaults or replace application diagnostics with explicit sampler/limits', async () => {
  // Synthetic setup belongs only to this isolated test process, not product code.
  const marker = 'SYNTHETIC_PROVIDER_ENV'; let markerMessages = 0, ordinaryMessages = 0;
  const observe = (...args) => {
    if (args.some(value => typeof value === 'string' && value.includes(marker))) markerMessages++;
    if (args.includes('ordinary synthetic diagnostic')) ordinaryMessages++;
  };
  const logger = { verbose: observe, debug: observe, info: observe, warn: observe, error: observe };
  api.diag.setLogger(logger, { logLevel: api.DiagLogLevel.ALL });
  try {
    process.env.OTEL_TRACES_SAMPLER = marker;
    process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = marker;
    const handle = await init();
    assert.equal(handle.tracer.withSpan('ordinary', span => span.isRecording()), true);
    await handle.forceFlush(); await handle.shutdown();
    api.diag.warn('ordinary synthetic diagnostic');
    assert.equal(markerMessages, 0); assert.equal(ordinaryMessages, 1); assert.equal(spans.length, 1);
  } finally { api.diag.disable(); }
});
