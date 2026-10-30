'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function source(file, mocks = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', code)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (!name.startsWith('.')) return require(name);
    const base = path.resolve(root, path.dirname(file), name);
    const target = fs.existsSync(base + '.ts') ? base + '.ts' : path.join(base, 'index.ts');
    return fs.existsSync(target) ? source(path.relative(root, target)) : require(base);
  }, exports);
  return exports;
}

test('config snapshots detach enumerable data and preserve opaque callback identity without invoking hidden accessors', () => {
  const { snapshotConfig } = source('core/memory/ConfigSnapshot.ts');
  let invoked = 0;
  const callback = () => { invoked++; };
  const input = { service: { serviceName: 'ordinary \ud83d\ude00' }, values: ['a', true, 0, null], callback };
  Object.defineProperty(input, 'hidden', { get() { invoked++; throw new Error('MUST_NOT_READ'); } });
  Object.defineProperty(input, Symbol('hidden'), { enumerable: true, get() { invoked++; } });
  const copy = snapshotConfig(input);
  assert.notEqual(copy, input); assert.notEqual(copy.service, input.service); assert.notEqual(copy.values, input.values);
  assert.equal(copy.service.serviceName, input.service.serviceName); assert.equal(copy.callback, callback);
  assert.equal(Object.getPrototypeOf(copy), null); assert.equal(Object.isFrozen(copy), true);
  assert.equal(Object.hasOwn(copy, 'hidden'), false); assert.equal(invoked, 0);
  input.service.serviceName = 'changed'; assert.equal(copy.service.serviceName, 'ordinary \ud83d\ude00');
});

test('config rejects enumerable getters, cycles, invalid scalar values and class prototypes with fixed errors', () => {
  const { snapshotConfig, ownBoolean } = source('core/memory/ConfigSnapshot.ts');
  let invoked = 0;
  const getter = Object.defineProperty({}, 'service', { enumerable: true, get() { invoked++; } });
  assert.throws(() => snapshotConfig(getter), /ELVEN_CONFIG_ACCESSOR/);
  assert.equal(ownBoolean(Object.defineProperty({}, 'failOpen', { get() { invoked++; } }), 'failOpen'), false);
  const cycle = {}; cycle.self = cycle;
  for (const value of [cycle, { value: NaN }, { value: Infinity }, { value: 1n }, new (class Config {})()]) {
    assert.throws(() => snapshotConfig(value), /^Error: ELVEN_CONFIG_(BUDGET|VALUE)$/);
  }
  assert.equal(invoked, 0);
});

test('RegExp snapshots use intrinsic source/flags and never read caller accessors, test or lastIndex state', () => {
  const { snapshotConfig } = source('core/memory/ConfigSnapshot.ts');
  let invoked = 0;
  const pattern = /ordinary/gi; pattern.lastIndex = 19;
  for (const key of ['source', 'flags']) Object.defineProperty(pattern, key, { get() { invoked++; throw new Error('MUST_NOT_READ'); } });
  pattern.test = () => { invoked++; throw new Error('MUST_NOT_CALL'); };
  const copy = snapshotConfig({ pattern }).pattern;
  assert.notEqual(copy, pattern); assert.equal(copy.source, 'ordinary'); assert.equal(copy.flags, 'gi');
  assert.equal(copy.lastIndex, 0); assert.equal(pattern.lastIndex, 19); assert.equal(invoked, 0);
});

test('config enforces total/depth/container limits and rule-array length before reading elements', () => {
  const { snapshotConfig } = source('core/memory/ConfigSnapshot.ts');
  let invoked = 0;
  const rules = new Array(33); Object.defineProperty(rules, 0, { enumerable: true, get() { invoked++; } });
  assert.throws(() => snapshotConfig({ tracing: { sampling: { rules } } }), /ELVEN_SAMPLER_RULE_BUDGET/);
  assert.throws(() => snapshotConfig({ values: Array(20).fill('x'.repeat(32768)) }), /ELVEN_CONFIG_BUDGET/);
  assert.throws(() => snapshotConfig({ values: Array.from({ length: 600 }, () => ({})) }), /ELVEN_CONFIG_BUDGET/);
  let deep = {}; for (let i = 0; i < 14; i++) deep = { deep };
  assert.throws(() => snapshotConfig(deep), /ELVEN_CONFIG_BUDGET/); assert.equal(invoked, 0);
});

test('root metric options reject nonfinite, fractional counts and limits while keeping normal booleans and intervals', () => {
  const { observabilitySnapshot } = source('api/config.ts');
  const config = metrics => ({ service: { serviceName: 'ordinary' }, metrics });
  for (const cardinalityLimit of [NaN, Infinity, -Infinity, 0, 1, 1.5, 100001]) {
    assert.throws(() => observabilitySnapshot(config({ cardinalityLimit })), /ELVEN_CONFIG_VALUE/);
  }
  for (const maxExportBatchSize of [NaN, Infinity, 0, -1, 1.5, 100001]) {
    assert.throws(() => observabilitySnapshot(config({ maxExportBatchSize })), /ELVEN_CONFIG_VALUE/);
  }
  for (const exportIntervalMillis of [Infinity, 0, -1, 300001]) {
    assert.throws(() => observabilitySnapshot(config({ exportIntervalMillis })), /ELVEN_CONFIG_VALUE/);
  }
  const ordinary = observabilitySnapshot(config({ cardinalityLimit: 500, maxExportBatchSize: 512, exportIntervalMillis: 1.5 }));
  assert.equal(ordinary.metrics.exportIntervalMillis, 1.5);
  assert.throws(() => observabilitySnapshot({ ...config({}), privacy: { hashUserId: 'false' } }), /ELVEN_CONFIG_VALUE/);
});

test('direct sampler snapshots rules, rejects sparse/accessor rules and default path does not load matcher engines', () => {
  const { SmartSampler } = source('core/sampler/SmartSampler.ts');
  const api = require('@opentelemetry/api');
  const before = ['re2js', '@eslint-community/regexpp'].map(name => require.cache[require.resolve(name)]);
  const rule = { attributeKey: 'route', attributeValue: 'private', decision: 0 };
  const sampler = new SmartSampler({ ratio: 1, rules: [rule] }); rule.attributeValue = 'changed';
  const sample = attributes => sampler.shouldSample(api.ROOT_CONTEXT, '1'.repeat(32), 'ordinary', 0, attributes, []);
  assert.equal(sample({ route: 'private' }).decision, 0); assert.equal(sample({ route: 'ordinary' }).decision, 2);
  let invoked = 0;
  assert.equal(sample(Object.defineProperty({}, 'route', { get() { invoked++; } })).decision, 0);
  assert.equal(invoked, 0); assert.equal(sampler.getDroppedInputs(), 1);
  assert.throws(() => new SmartSampler({ rules: new Array(1) }), /ELVEN_SAMPLER_UNSUPPORTED_RULE/);
  assert.throws(() => new SmartSampler({ get rules() { invoked++; return []; } }), /ELVEN_CONFIG_ACCESSOR/);
  assert.deepEqual(['re2js', '@eslint-community/regexpp'].map(name => require.cache[require.resolve(name)]), before);
  sampler.close(); assert.equal(sample({}).decision, 0);
});

test('metric metadata admission precedes Map hashing and cached instruments remain usable at capacity', () => {
  const { MetricFacade } = source('core/metrics/MetricFacade.ts');
  const calls = [], meter = { createCounter: () => ({ add: (...args) => calls.push(args) }) };
  const facade = new MetricFacade('ordinary', undefined, meter);
  let hashes = 0; const has = facade._counters.has.bind(facade._counters);
  facade._counters.has = name => { hashes++; return has(name); };
  facade.getCounter('x'.repeat(256)).add(1); assert.equal(hashes, 0);
  const first = facade.getCounter('first');
  for (let index = 1; index < 128; index++) facade.getCounter(`metric_${index}`);
  assert.equal(facade.getCounter('first'), first); facade.getCounter('overflow').add(1);
  first.add(2, { method: 'GET', route: '/ordinary', status: 200 });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 2); assert.equal(facade.getDroppedInstruments(), 2);
});

test('known-key metric and Resource privacy preserve ordinary dimensions/context and explicit raw opt-outs', () => {
  const { MetricFacade } = source('core/metrics/MetricFacade.ts');
  const { ResourceBuilder } = source('core/resources/ResourceBuilder.ts');
  let observed;
  const context = {}, attrs = { route: '/ordinary', method: 'GET', status: 200, 'db.statement': 'SYNTHETIC_SQL', 'user.id': 'SYNTHETIC_USER' };
  const meter = { createCounter: () => ({ add: (value, attributes, ctx) => { observed = { value, attributes, ctx }; } }) };
  new MetricFacade('ordinary', undefined, meter).getCounter('events').add(1, attrs, context);
  assert.equal(observed.ctx, context); assert.equal(observed.attributes.route, '/ordinary');
  assert.equal(observed.attributes.method, 'GET'); assert.equal(observed.attributes.status, 200);
  assert.equal(observed.attributes['db.statement'], '[REDACTED]'); assert.match(observed.attributes['user.id'], /^[a-f0-9]{16}$/);
  assert.equal(attrs['db.statement'], 'SYNTHETIC_SQL');
  const resource = new ResourceBuilder({ serviceName: 'ordinary', attributes: attrs }).detect();
  assert.equal(resource.attributes['db.statement'], '[REDACTED]'); assert.equal(resource.attributes.route, '/ordinary');
  const raw = { redactDbStatement: false, hashUserId: false, allowRawAttributes: ['db.statement'] };
  new MetricFacade('ordinary', undefined, meter, raw).getCounter('events').add(1, attrs, context);
  assert.equal(observed.attributes['db.statement'], 'SYNTHETIC_SQL'); assert.equal(observed.attributes['user.id'], 'SYNTHETIC_USER');
});

test('shutdown guards preserve one operation and its rejection across concurrent cleanup', async () => {
  const { onceShutdown } = source('core/memory/ConfigSnapshot.ts');
  let calls = 0; const original = new Error('synthetic shutdown');
  const owner = onceShutdown({ async shutdown() { calls++; throw original; } });
  const a = owner.shutdown(), b = owner.shutdown(); assert.equal(a, b);
  const results = await Promise.allSettled([a, b, owner.shutdown()]);
  assert.equal(calls, 1); for (const result of results) assert.equal(result.reason, original);
});

test('tracer callbacks keep results and exact sync/async exceptions when telemetry methods fail', async () => {
  const { TracerFacade } = source('core/tracing/TracerFacade.ts');
  const failed = () => { throw new Error('synthetic telemetry'); };
  const facade = new TracerFacade('ordinary', undefined, { startSpan: () => ({ end: failed, setStatus: failed, recordException: failed }) });
  assert.equal(facade.withSpan('normal', () => 7), 7);
  const original = new Error('synthetic business');
  assert.throws(() => facade.withSpan('sync', () => { throw original; }), error => error === original);
  await assert.rejects(facade.withSpan('async', async () => { throw original; }), error => error === original);
  const startupFailure = new TracerFacade('ordinary', undefined, { startSpan: failed });
  let ran = 0; assert.equal(startupFailure.withSpan('fallback', span => { ran++; return span.isRecording(); }), false);
  assert.equal(ran, 1);
});

test('partial public provider startup preserves its error while rollback settles owned readers and globals', async () => {
  const api = require('@opentelemetry/api');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  let providerStops = 0, readerStops = 0;
  const startupError = new Error('synthetic start'), cleanupError = new Error('synthetic SDK shutdown');
  class FakeMeterProvider {
    getMeter() { return api.createNoopMeter(); }
    async shutdown() { providerStops++; throw cleanupError; }
  }
  class FailedTracerProvider { constructor() { throw startupError; } }
  const { NodeRuntime } = source('runtime/node/index.ts', {
    '@opentelemetry/sdk-metrics': { MeterProvider: FakeMeterProvider },
    '@opentelemetry/sdk-trace': { TracerProvider: FailedTracerProvider },
    './ProcessBootstrap': { registerProcessBootstrap() {} },
  });
  const reader = { async shutdown() { readerStops++; } };
  const runtime = new NodeRuntime({ resource: resourceFromAttributes({}), metricReaders: [reader], spanProcessors: [{ async shutdown() {} }] });
  try {
    await assert.rejects(runtime.start(), error => error === startupError);
    await assert.rejects(runtime.shutdown(), error => error === cleanupError);
    assert.equal(api.metrics.getMeterProvider() instanceof FakeMeterProvider, false);
    assert.equal(providerStops, 1); assert.equal(readerStops, 1); assert.equal(runtime.isStarted(), false);
  } finally { api.metrics.disable(); }
});
