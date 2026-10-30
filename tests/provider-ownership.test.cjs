'use strict';
const assert = require('node:assert/strict');
const { test, beforeEach, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const api = require('@opentelemetry/api');
const root = path.resolve(__dirname, '..');
const savedEnv = { traces: process.env.OTEL_TRACES_EXPORTER, metrics: process.env.OTEL_METRICS_EXPORTER };
beforeEach(() => { process.env.OTEL_TRACES_EXPORTER = 'none'; process.env.OTEL_METRICS_EXPORTER = 'none'; });
afterEach(() => {
  for (const [key, value] of [['OTEL_TRACES_EXPORTER', savedEnv.traces], ['OTEL_METRICS_EXPORTER', savedEnv.metrics]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function source(file, mocks = {}, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', code)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(root, path.dirname(file), name);
    const target = fs.existsSync(base + '.ts') ? base + '.ts' : path.join(base, 'index.ts');
    return fs.existsSync(target) ? source(path.relative(root, target), mocks, cache) : require(base);
  }, exports);
  return exports;
}

function runtimeFixture(bootstrap = () => {}) {
  const traces = [], meters = [];
  class FakeTrace {
    constructor(options) { this.options = options; this.stops = 0; traces.push(this); }
    getTracer() { return new api.ProxyTracerProvider().getTracer('owned'); }
    async shutdown() { this.stops++; }
  }
  class FakeMeter {
    constructor(options) { this.options = options; this.stops = 0; meters.push(this); }
    getMeter() { return api.createNoopMeter(); }
    async shutdown() { this.stops++; }
  }
  const { NodeRuntime } = source('runtime/node/index.ts', {
    '@opentelemetry/sdk-trace': { TracerProvider: FakeTrace },
    '@opentelemetry/sdk-metrics': { MeterProvider: FakeMeter },
    './ProcessBootstrap': { registerProcessBootstrap: bootstrap },
  });
  return { NodeRuntime, traces, meters };
}
const resource = () => require('@opentelemetry/resources').resourceFromAttributes({ 'service.name': 'ordinary', 'host.name': 'synthetic-host' });
const component = () => ({ stops: 0, async shutdown() { this.stops++; }, async forceFlush() {} });

test('public providers receive the unchanged Resource, sampler, six span limits, readers and views', async () => {
  let boots = 0;
  const { NodeRuntime, traces, meters } = runtimeFixture(() => { boots++; });
  const r = resource(), sampler = {}, processor = component(), reader = component();
  const views = [{ instrumentName: 'ordinary', name: 'ordinary_total' }];
  const runtime = new NodeRuntime({ resource: r, sampler, spanProcessors: [processor], metricReaders: [reader], views });
  try {
    await runtime.start(); await runtime.start();
    assert.equal(boots, 1); assert.equal(traces.length, 1); assert.equal(meters.length, 1);
    assert.equal(traces[0].options.resource, r); assert.equal(meters[0].options.resource, r);
    assert.equal(traces[0].options.sampler, sampler); assert.equal(meters[0].options.views, views);
    assert.deepEqual(traces[0].options.spanLimits, {
      attributeValueLengthLimit: 4096, attributeCountLimit: 128, eventCountLimit: 64,
      linkCountLimit: 64, attributePerEventCountLimit: 64, attributePerLinkCountLimit: 64,
    });
    assert.equal(traces[0].options.spanProcessors[0], processor); assert.equal(meters[0].options.readers[0], reader);
    await runtime.shutdown(); await runtime.shutdown();
    assert.equal(traces[0].stops, 1); assert.equal(meters[0].stops, 1);
    assert.equal(processor.stops, 1); assert.equal(reader.stops, 1);
    assert.equal(runtime.isStarted(), false);
  } finally { await runtime.shutdown(); api.trace.disable(); api.metrics.disable(); }
});

test('no trace/meter backend is constructed for missing pipelines and explicit bindings never use foreign globals', async () => {
  const { NodeRuntime, traces, meters } = runtimeFixture();
  let foreignCalls = 0;
  const foreignTrace = { getTracer() { foreignCalls++; return new api.ProxyTracerProvider().getTracer('foreign'); } };
  const foreignMeter = { getMeter() { foreignCalls++; return api.createNoopMeter(); } };
  assert.equal(api.trace.setGlobalTracerProvider(foreignTrace), true);
  assert.equal(api.metrics.setGlobalMeterProvider(foreignMeter), true);
  const traceGlobal = api.trace.getTracerProvider();
  const runtime = new NodeRuntime({ resource: resource() });
  try {
    await runtime.start();
    const providers = runtime.getSignalProviders();
    assert.equal(providers.tracerProvider.getTracer('ordinary').startSpan('ordinary').isRecording(), false);
    providers.meterProvider.getMeter('ordinary').createCounter('ordinary').add(1);
    await runtime.shutdown();
    assert.equal(traces.length, 0); assert.equal(meters.length, 0); assert.equal(foreignCalls, 0);
    assert.equal(api.trace.getTracerProvider(), traceGlobal); assert.equal(api.metrics.getMeterProvider(), foreignMeter);
  } finally { await runtime.shutdown(); api.trace.disable(); api.metrics.disable(); }
});

test('foreign trace registration failure rolls back already-owned metrics without bootstrapping or disabling the foreign provider', async () => {
  let boots = 0;
  const { NodeRuntime, traces, meters } = runtimeFixture(() => { boots++; });
  const foreign = { getTracer: () => new api.ProxyTracerProvider().getTracer('foreign') };
  assert.equal(api.trace.setGlobalTracerProvider(foreign), true);
  const before = api.trace.getTracerProvider(), reader = component();
  const runtime = new NodeRuntime({ resource: resource(), spanProcessors: [component()], metricReaders: [reader] });
  try {
    await assert.rejects(runtime.start(), /could not register its global provider/);
    assert.equal(boots, 0); assert.equal(api.trace.getTracerProvider(), before);
    assert.equal(traces[0].stops, 1); assert.equal(meters[0].stops, 1); assert.equal(reader.stops, 1);
    assert.notEqual(api.metrics.getMeterProvider(), meters[0]);
    await assert.rejects(runtime.start(), /ELVEN_RUNTIME_CLOSED/);
  } finally { await runtime.shutdown(); api.trace.disable(); api.metrics.disable(); }
});

test('foreign meter registration failure never constructs tracing and leaves that foreign meter current', async () => {
  const { NodeRuntime, traces, meters } = runtimeFixture();
  const foreign = { getMeter: () => api.createNoopMeter() };
  assert.equal(api.metrics.setGlobalMeterProvider(foreign), true);
  const runtime = new NodeRuntime({ resource: resource(), spanProcessors: [component()], metricReaders: [component()] });
  try {
    await assert.rejects(runtime.start(), /could not register its global provider/);
    assert.equal(traces.length, 0); assert.equal(meters[0].stops, 1);
    assert.equal(api.metrics.getMeterProvider(), foreign);
  } finally { await runtime.shutdown(); api.metrics.disable(); }
});

test('replacement trace/meter owners installed after startup survive shutdown of the old generation', async () => {
  const { NodeRuntime, traces, meters } = runtimeFixture();
  const runtime = new NodeRuntime({ resource: resource(), spanProcessors: [component()], metricReaders: [component()] });
  try {
    await runtime.start(); api.trace.disable(); api.metrics.disable();
    const foreignTrace = { getTracer: () => new api.ProxyTracerProvider().getTracer('replacement') };
    const foreignMeter = { getMeter: () => api.createNoopMeter() };
    assert.equal(api.trace.setGlobalTracerProvider(foreignTrace), true);
    assert.equal(api.metrics.setGlobalMeterProvider(foreignMeter), true);
    const before = api.trace.getTracerProvider();
    await runtime.shutdown();
    assert.equal(api.trace.getTracerProvider(), before); assert.equal(api.metrics.getMeterProvider(), foreignMeter);
    assert.equal(traces[0].stops, 1); assert.equal(meters[0].stops, 1);
  } finally { await runtime.shutdown(); api.trace.disable(); api.metrics.disable(); }
});

test('experimental SDK metrics opt-in is passed to both public providers without new defaults', async () => {
  const old = process.env.OTEL_NODE_EXPERIMENTAL_SDK_METRICS;
  process.env.OTEL_NODE_EXPERIMENTAL_SDK_METRICS = 'true';
  const { NodeRuntime, traces, meters } = runtimeFixture();
  const runtime = new NodeRuntime({ resource: resource(), spanProcessors: [component()], metricReaders: [component()] });
  try {
    await runtime.start(); assert.equal(meters[0].options.sdkMetricsEnabled, true);
    assert.equal(traces[0].options.meterProvider, meters[0]);
  } finally {
    await runtime.shutdown(); api.trace.disable(); api.metrics.disable();
    if (old === undefined) delete process.env.OTEL_NODE_EXPERIMENTAL_SDK_METRICS;
    else process.env.OTEL_NODE_EXPERIMENTAL_SDK_METRICS = old;
  }
});

test('runtime forwards explicit null propagation unchanged and bootstrap failure rolls owned providers back', async () => {
  const failure = new Error('synthetic bootstrap'); let observed;
  const { NodeRuntime, traces, meters } = runtimeFixture(value => { observed = value; throw failure; });
  const runtime = new NodeRuntime({ resource: resource(), textMapPropagator: null,
    spanProcessors: [component()], metricReaders: [component()] });
  try {
    await assert.rejects(runtime.start(), error => error === failure);
    assert.equal(observed, null); assert.equal(runtime.isStarted(), false);
    assert.equal(traces[0].stops, 1); assert.equal(meters[0].stops, 1);
    assert.notEqual(api.metrics.getMeterProvider(), meters[0]);
    assert.notEqual(api.trace.getTracerProvider().getDelegate(), traces[0]);
  } finally { await runtime.shutdown(); api.trace.disable(); api.metrics.disable(); }
});

test('bootstrap is lazy/shared/register-only, honors null, and never disables a foreign context or propagator', () => {
  const key = Symbol.for('elven.observability.node.bootstrap.v2');
  assert.equal(globalThis[key], undefined);
  let managers = 0, enabled = 0, propagators = 0, disables = 0;
  const contexts = [], propagations = [];
  class Manager { constructor() { managers++; } enable() { enabled++; return this; } disable() { disables++; } }
  const { registerProcessBootstrap } = source('runtime/node/ProcessBootstrap.ts', {
    '@opentelemetry/api': {
      context: { setGlobalContextManager: owner => { contexts.push(owner); return false; } },
      propagation: { setGlobalPropagator: owner => { propagations.push(owner); return false; } },
    },
    '@opentelemetry/context-async-hooks': { AsyncLocalStorageContextManager: Manager },
    '../../core/propagation': { NetworkPropagator: { create() { propagators++; return {}; } } },
  });
  try {
    assert.equal(managers, 0); registerProcessBootstrap(null); assert.equal(propagations.length, 0);
    registerProcessBootstrap(); registerProcessBootstrap();
    assert.equal(managers, 1); assert.equal(enabled, 1); assert.equal(propagators, 1); assert.equal(disables, 0);
    assert.equal(contexts[0], contexts[2]); assert.equal(propagations[0], propagations[1]);
  } finally { delete globalThis[key]; } // This test created the synthetic bootstrap, not a live pipeline.
});

function rootFixture({ startFailure, registerFailure } = {}) {
  const events = [], providers = {
    tracerProvider: new api.ProxyTracerProvider(), meterProvider: { getMeter: () => api.createNoopMeter() },
  };
  const instrumentation = { disable() { events.push('disable'); } };
  let registrations = 0;
  class Runtime {
    async start() { events.push('start'); if (startFailure) throw startFailure; this.started = true; }
    getSignalProviders() { events.push('bindings'); return providers; }
    async shutdown() { events.push('shutdown'); this.started = false; }
    async forceFlush() {}
    isStarted() { return this.started === true; }
  }
  const sdk = source('api/public-api.ts', {
    '../runtime/node': { NodeRuntime: Runtime },
    '../instrumentations': { getCoreInstrumentations(options) {
      assert.equal(options.meterProvider, providers.meterProvider); events.push('construct'); return [instrumentation];
    } },
    '@opentelemetry/instrumentation': { registerInstrumentations(options) {
      registrations++; events.push('register'); assert.equal(options.tracerProvider, providers.tracerProvider);
      assert.equal(options.meterProvider, providers.meterProvider);
      if (registerFailure) throw registerFailure;
      return () => instrumentation.disable();
    } },
  });
  const config = { service: { serviceName: 'root-unit' }, autoShutdown: false,
    tracing: { enabled: true }, metrics: { enabled: false } };
  return { sdk, config, events, registrations: () => registrations };
}

test('root registers instrumentations once only after successful provider startup and duplicate init reuses its handle', async () => {
  const f = rootFixture(); const handle = await f.sdk.initObservability(f.config);
  try {
    assert.equal(await f.sdk.initObservability(f.config), handle);
    assert.equal(f.registrations(), 1); assert.deepEqual(f.events.slice(0, 4), ['start', 'bindings', 'construct', 'register']);
  } finally { await handle.shutdown(); }
  assert.equal(f.events.filter(event => event === 'disable').length, 1);
});

test('root provider-start failure never constructs or registers instrumentations and retains the original exception', async () => {
  const failure = new Error('synthetic startup'); const f = rootFixture({ startFailure: failure });
  await assert.rejects(f.sdk.initObservability(f.config), error => error === failure);
  assert.equal(f.registrations(), 0); assert.equal(f.events.includes('construct'), false);
  assert.equal(f.events.includes('shutdown'), true);
});

test('root instrumentation registration failure disables the owned list, rolls providers back and permits new initialization', async () => {
  const failure = new Error('synthetic registration'); const f = rootFixture({ registerFailure: failure });
  await assert.rejects(f.sdk.initObservability(f.config), error => error === failure);
  assert.equal(f.registrations(), 1); assert.equal(f.events.includes('disable'), true); assert.equal(f.events.includes('shutdown'), true);
  const fresh = rootFixture(); const handle = await fresh.sdk.initObservability(fresh.config);
  try { assert.equal(handle.isStarted(), true); assert.equal(fresh.registrations(), 1); }
  finally { await handle.shutdown(); }
});

test('HTTP body histograms use the explicit meter instead of a foreign global and retain ordinary dimensions', () => {
  const key = Symbol.for('elven.observability.node.instrumentations.v1');
  assert.equal(globalThis[key], undefined);
  let observedConfig, foreignCalls = 0; const rows = [];
  const instrumentation = { instrumentationName: 'http', getConfig: () => ({ enabled: true }), setConfig(value) { observedConfig = value; }, enable() {}, disable() {} };
  const { getCoreInstrumentations } = source('instrumentations/index.ts', {
    '@opentelemetry/api': { metrics: { getMeterProvider() { foreignCalls++; throw new Error('MUST_NOT_USE_FOREIGN'); } } },
    '@opentelemetry/auto-instrumentations-node': { getNodeAutoInstrumentations: () => [instrumentation] },
    './config': { INSTRUMENTATION_NAMES: ['http'] },
    './registry': { getAutoInstrumentationsConfig: () => ({ http: { enabled: true }, '@opentelemetry/instrumentation-http': { enabled: true } }) },
  });
  // Match the real registry name; synthetic classes exercise only this hook's binding.
  instrumentation.instrumentationName = '@opentelemetry/instrumentation-http';
  const meterProvider = { getMeter: () => ({ createHistogram: name => ({ record: (value, attrs) => rows.push({ name, value, attrs }) }) }) };
  try {
    getCoreInstrumentations({ privacy: {}, meterProvider });
    observedConfig.applyCustomAttributesOnSpan({}, { headers: { 'content-length': '7' }, method: 'POST' }, { getHeader: () => '11', statusCode: 201 });
    assert.equal(foreignCalls, 0); assert.deepEqual(rows.map(row => row.value), [11, 7]);
    for (const row of rows) assert.deepEqual(row.attrs, { 'http.request.method': 'POST', 'http.response.status_code': 201 });
  } finally { delete globalThis[key]; }
});
