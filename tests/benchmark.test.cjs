const assert = require('node:assert/strict');
const { test } = require('node:test');
const { overhead, median, cleanEnvironment } = require('../benchmarks/run-benchmark.cjs');
test('benchmark rejects missing latency instead of treating it as a zero-cost sample', () => {
  assert.throws(() => overhead({ requests: 100 }, { requests: 99 }), /Missing p99/);
  assert.equal(overhead({ latencyP99: 10 }, { latencyP99: 11 }).value.toFixed(0), '10');
  assert.equal(overhead({ latencyP99: 0, requests: 100 }, { latencyP99: 0, requests: 50 }).value, 50);
  assert.equal(median([100, 0, 50]), 50);
});
test('benchmark comparison ignores inherited instrumentation and preload settings', () => {
  process.env.OTEL_TRACES_SAMPLER_ARG = '0';
  process.env.NODE_OPTIONS = '--require never';
  const env = cleanEnvironment();
  assert.equal(env.OTEL_TRACES_SAMPLER_ARG, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  delete process.env.OTEL_TRACES_SAMPLER_ARG;
  delete process.env.NODE_OPTIONS;
});
