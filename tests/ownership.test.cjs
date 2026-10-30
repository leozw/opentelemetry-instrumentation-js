'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { createTraceState } = require('@opentelemetry/api');
const root = path.resolve(__dirname, '..');
function source(file, mocks = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', code)(name => {
    if (mocks[name]) return mocks[name];
    if (name.startsWith('.')) {
      const resolved = path.resolve(root, path.dirname(file), name);
      if (fs.existsSync(resolved + '.ts')) return source(path.relative(root, resolved + '.ts'));
      return require(resolved);
    }
    return require(name);
  }, exports);
  return exports;
}
function context(index = '1') {
  return { traceId: index.repeat(32), spanId: '2'.repeat(16), traceFlags: 1, isRemote: true, traceState: createTraceState('vendor=ordinary') };
}
function readable(attributes = {}, overrides = {}) {
  const ctx = context();
  return { name: 'ordinary \ud83d\ude00', kind: 1, status: { code: 2, message: 'failure \u00a0\ufeff' }, attributes,
    spanContext: () => ctx, parentSpanContext: context('3'),
    startTime: [1, 2], endTime: [3, 4], duration: [2, 2], ended: true,
    events: [{ name: 'event \ud83d\ude00', time: [2, 3], attributes: { size: [0, 1, null], detail: 'ordinary' }, droppedAttributesCount: 2 }],
    links: [{ context: context('4'), attributes: { link: true }, droppedAttributesCount: 1 }],
    instrumentationScope: { name: 'scope', version: '1', schemaUrl: 'https://schema.example.test/v1' },
    resource: resourceFromAttributes({ 'service.name': 'ordinary', other: ['a', 'b'] }, { schemaUrl: 'https://schema.example.test/resource' }),
    droppedAttributesCount: 3, droppedEventsCount: 4, droppedLinksCount: 5, ...overrides };
}

test('owned strings preserve normal UTF16, astral/NBSP/BOM and reject lone code units without caller mutation', () => {
  const { ownedString } = source('core/memory/OwnedData.ts');
  for (const value of ['ordinary', 'e\u0301', ' \u00a0\ufeffbearer ', '\ud83d\ude00', 'x\ud83d\ude00y']) assert.equal(ownedString(value, 128), value);
  assert.equal(ownedString(undefined, 1), undefined);
  for (const value of ['\ud800', '\udc00', 'x\ud800y', '\ud800\ud800\udc00']) {
    const before = Buffer.from(value, 'utf16le').toString('hex');
    assert.throws(() => ownedString(value, 128), error => error.message === 'ELVEN_METADATA_UNSUPPORTED_UNICODE');
    assert.equal(Buffer.from(value, 'utf16le').toString('hex'), before);
  }
  assert.throws(() => ownedString('a'.repeat(129), 128), /ELVEN_METADATA_BUDGET/);
});

test('attribute snapshots own keys/arrays, preserve scalar types and do not invoke accessors or serialization hooks', () => {
  const { DataBudget } = source('core/memory/OwnedData.ts');
  const array = Object.freeze(['ordinary \ud83d\ude00', 0, false, null, undefined]);
  const input = Object.freeze({ array, text: 'ordinary', count: 0, flag: false });
  const copy = new DataBudget().attributes(input);
  assert.notEqual(copy, input); assert.notEqual(copy.array, array); assert.deepEqual([...copy.array], [...array]);
  assert.deepEqual({ ...copy }, { ...input }); assert.equal(Object.getPrototypeOf(copy), null);
  let invoked = 0;
  const getter = Object.defineProperty({}, 'private', { enumerable: true, get() { invoked++; return 'MUST_NOT_READ'; } });
  assert.throws(() => new DataBudget().attributes(getter), /ELVEN_PAYLOAD_BUDGET/);
  const toJSON = { toJSON() { invoked++; return 'MUST_NOT_SERIALIZE'; } };
  assert.throws(() => new DataBudget().attributes({ object: toJSON }), /ELVEN_PAYLOAD_BUDGET/);
  assert.equal(invoked, 0);
  for (const value of [NaN, Infinity, -Infinity, {}, () => {}, 1n]) assert.throws(() => new DataBudget().attributes({ value }), /ELVEN_PAYLOAD_BUDGET/);
  assert.throws(() => new DataBudget().attributes({ array: Array(65).fill('a') }), /ELVEN_PAYLOAD_BUDGET/);
  assert.throws(() => new DataBudget(1).text('a'), /ELVEN_PAYLOAD_BUDGET/);
});

test('ended span projection retains every supported field but no original object, prototype, delegate or per-span method closure', () => {
  const { SpanPayloadLimitProcessor } = source('core/tracing/SpanPayloadLimitProcessor.ts');
  const accepted = [], delegate = { onEnd(span) { accepted.push(span); } };
  const processor = new SpanPayloadLimitProcessor(delegate);
  const original = readable({ array: Object.freeze(['a', 'b']), value: 'ordinary \ud83d\ude00' });
  const expectedContext = original.spanContext();
  const other = readable({}, { resource: original.resource, spanContext: () => context('5') });
  Object.setPrototypeOf(original, { PRIVATE_BACKREF: delegate });
  processor.onEnd(original); processor.onEnd(other); assert.equal(accepted.length, 2);
  const copy = accepted[0]; assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.notEqual(copy, original); assert.notEqual(copy.attributes, original.attributes);
  assert.notEqual(copy.attributes.array, original.attributes.array);
  assert.notEqual(copy.events, original.events); assert.notEqual(copy.events[0], original.events[0]);
  assert.notEqual(copy.events[0].attributes, original.events[0].attributes);
  assert.notEqual(copy.links[0], original.links[0]); assert.notEqual(copy.links[0].context, original.links[0].context);
  assert.notEqual(copy.parentSpanContext, original.parentSpanContext); assert.notEqual(copy.instrumentationScope, original.instrumentationScope);
  assert.notEqual(copy.resource, original.resource); assert.equal(copy.resource, accepted[1].resource);
  for (const key of ['name', 'kind', 'ended', 'status', 'duration', 'startTime', 'endTime', 'droppedAttributesCount', 'droppedEventsCount', 'droppedLinksCount', 'instrumentationScope']) assert.deepEqual(copy[key], original[key]);
  assert.notEqual(copy.startTime, original.startTime); assert.notEqual(copy.events[0].time, original.events[0].time);
  assert.deepEqual(copy.spanContext(), expectedContext); assert.notEqual(copy.spanContext(), expectedContext);
  assert.notEqual(copy.spanContext().traceState, expectedContext.traceState);
  assert.equal(copy.spanContext, accepted[1].spanContext);
  assert.equal(copy.spanContext.call(accepted[1]).traceId, '5'.repeat(32));
  const forbidden = new Set([original, other, delegate, expectedContext, original.attributes, original.attributes.array, original.events, original.events[0], original.links, original.links[0], original.links[0].context, original.resource, original.instrumentationScope]);
  const visited = new Set();
  function walk(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || visited.has(value)) return;
    assert.equal(forbidden.has(value), false); visited.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in descriptor) walk(descriptor.value);
  }
  walk(copy);
  copy.attributes.value = 'changed'; copy.events[0].attributes.detail = 'changed';
  assert.equal(original.attributes.value, 'ordinary \ud83d\ude00'); assert.equal(original.events[0].attributes.detail, 'ordinary');
  assert.deepEqual(original.spanContext(), expectedContext);
});

test('span budget includes IDs/scope/tracestate and drops malformed or oversized data without delegate calls', () => {
  const { SpanPayloadLimitProcessor } = source('core/tracing/SpanPayloadLimitProcessor.ts');
  let accepted = 0;
  const processor = new SpanPayloadLimitProcessor({ onEnd() { accepted++; } });
  for (const original of [readable({ value: '\ud800' }), readable({}, { name: '\udc00' }),
    readable({}, { instrumentationScope: { name: 'n'.repeat(256) } }), readable({}, { duration: [Infinity, 0] }),
    readable({}, { events: Array(65).fill({ name: 'event', time: [1, 0] }) }),
    readable({}, { links: Array.from({ length: 64 }, () => ({ context: { ...context(), traceState: { serialize: () => 'a'.repeat(512) } } })) }),
    readable({}, { resource: { asyncAttributesPending: true, attributes: {} } })]) processor.onEnd(original);
  assert.equal(accepted, 0);
  processor.onEnd(readable({ ordinary: ['\ud83d\ude00', '\u00a0', '\ufeff'] })); assert.equal(accepted, 1);
});

test('metric metadata/measurements are owned and bounded; normal units/values/context and callbacks remain intact', () => {
  const calls = [], created = [], warnings = [];
  const meter = Object.fromEntries(['Counter', 'Histogram', 'UpDownCounter'].map(kind => ['create' + kind, (name, options) => {
    created.push({ kind, name, options });
    return { add: (value, attrs, ctx) => calls.push({ value, attrs, ctx }), record: (value, attrs, ctx) => calls.push({ value, attrs, ctx }) };
  }]));
  const { MetricFacade } = source('core/metrics/MetricFacade.ts', { '@opentelemetry/api': { metrics: { getMeter: () => meter }, diag: { warn: code => warnings.push(code) } } });
  const facade = new MetricFacade('scope', '1', meter);
  const attrs = Object.freeze({ route: 'ordinary', array: Object.freeze(['a', 'b']) }), ctx = {};
  const counter = facade.getCounter('events', 'Events \ud83d\ude00'), histogram = facade.getHistogram('latency', 'milliseconds'), updown = facade.getUpDownCounter('connections');
  assert.equal(facade.getCounter('events'), counter);
  counter.add(1, attrs, ctx); histogram.record(12.5, attrs, ctx); updown.add(-1, attrs, ctx);
  assert.deepEqual(calls.map(call => call.value), [1, 12.5, -1]);
  assert.equal(calls[0].ctx, ctx); assert.notEqual(calls[0].attrs, attrs); assert.notEqual(calls[0].attrs.array, attrs.array);
  assert.deepEqual({ ...calls[0].attrs }, { ...attrs });
  assert.deepEqual(created[0], { kind: 'Counter', name: 'events', options: { description: 'Events \ud83d\ude00' } });
  for (const description of ['x'.repeat(1025), '\ud800']) assert.doesNotThrow(() => facade.getCounter('invalid', description).add(1));
  assert.equal(facade.getDroppedInstruments(), 2);
  for (const value of [NaN, Infinity, '1']) counter.add(value, attrs);
  counter.add(1, { bad: '\udc00' }); assert.equal(calls.length, 3); assert.equal(facade.getDroppedMeasurements(), 4);
  assert.deepEqual(warnings, ['ELVEN_METRIC_METADATA_BUDGET', 'ELVEN_METRIC_ATTRIBUTE_BUDGET']);
  assert.equal(attrs.route, 'ordinary');
});

test('resource schema bytes share the Resource budget and payload drop accounting saturates', () => {
  const { SpanPayloadLimitProcessor } = source('core/tracing/SpanPayloadLimitProcessor.ts');
  let accepted = 0;
  const processor = new SpanPayloadLimitProcessor({ onEnd() { accepted++; } });
  const resource = { attributes: { a: 'x'.repeat(65505) }, schemaUrl: 's'.repeat(200), asyncAttributesPending: false };
  processor.onEnd(readable({}, { resource }));
  assert.equal(accepted, 0); assert.equal(processor.getDroppedSpans(), 1);
  processor.droppedSpans = Number.MAX_SAFE_INTEGER;
  processor.onEnd(readable({ invalid: Infinity }));
  assert.equal(processor.getDroppedSpans(), Number.MAX_SAFE_INTEGER);
  processor.onEnd(readable()); assert.equal(accepted, 1);
});
