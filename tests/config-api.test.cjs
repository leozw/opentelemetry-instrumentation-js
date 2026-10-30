'use strict';
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const api = require('@opentelemetry/api');
const sdk = require('../dist/index.js');
const handles = new Set();
const config = () => ({ service: { serviceName: 'config-controls' }, autoShutdown: false, tracing: { enabled: false }, metrics: { enabled: false } });
afterEach(async () => {
  for (const handle of handles) await handle.shutdown();
  handles.clear(); delete process.env.OTEL_SDK_DISABLED;
});

test('global disable bypasses even service/config getters and remains a successful isolated no-op', async () => {
  process.env.OTEL_SDK_DISABLED = 'true'; let invoked = 0;
  const input = Object.defineProperty({}, 'service', { enumerable: true, get() { invoked++; throw new Error('MUST_NOT_READ'); } });
  const handle = await sdk.initObservability(input); handles.add(handle);
  assert.equal(handle.isStarted(), true); assert.equal(invoked, 0);
  assert.equal(handle.tracer.withSpan('business', span => span.isRecording()), false);
  await handle.forceFlush();
});

test('root admission rejects getters before service reads; only data failOpen opts into degraded continuation', async () => {
  let invoked = 0;
  const input = Object.defineProperty({}, 'service', { enumerable: true, get() { invoked++; throw new Error('MUST_NOT_READ'); } });
  await assert.rejects(sdk.initObservability(input), /ELVEN_CONFIG_ACCESSOR/);
  const failOpen = Object.defineProperty({ failOpen: true }, 'service', Object.getOwnPropertyDescriptor(input, 'service'));
  const noop = await sdk.initObservability(failOpen); handles.add(noop);
  assert.equal(noop.isStarted(), false); assert.equal(invoked, 0);
  const original = new Error('business');
  assert.throws(() => noop.tracer.withSpan('callback', () => { throw original; }), error => error === original);
});

test('manual signal disable neither borrows nor unregisters foreign trace/meter providers', async () => {
  let calls = 0;
  const foreignTrace = { getTracer() { calls++; return new api.ProxyTracerProvider().getTracer('foreign'); } };
  const foreignMeter = { getMeter() { calls++; return api.createNoopMeter(); } };
  assert.equal(api.trace.setGlobalTracerProvider(foreignTrace), true);
  assert.equal(api.metrics.setGlobalMeterProvider(foreignMeter), true);
  const beforeTrace = api.trace.getTracerProvider(), beforeMeter = api.metrics.getMeterProvider(), beforeCalls = calls;
  try {
    const handle = await sdk.initObservability(config()); handles.add(handle);
    handle.tracer.withSpan('business', () => 1); handle.metrics.increment('counter');
    await handle.shutdown();
    assert.equal(api.trace.getTracerProvider(), beforeTrace); assert.equal(api.metrics.getMeterProvider(), beforeMeter);
    assert.equal(calls, beforeCalls);
  } finally { api.trace.disable(); api.metrics.disable(); }
});

test('hot global disable owns only its separate no-op handle and does not shut down an existing generation', async () => {
  const active = await sdk.initObservability(config()); handles.add(active);
  process.env.OTEL_SDK_DISABLED = 'true';
  const disabled = await sdk.initObservability(undefined); handles.add(disabled);
  assert.notEqual(disabled, active); assert.equal(disabled.isStarted(), true); assert.equal(active.isStarted(), true);
  await disabled.shutdown(); assert.equal(active.isStarted(), true);
  delete process.env.OTEL_SDK_DISABLED;
  assert.equal(await sdk.initObservability(config()), active);
});
