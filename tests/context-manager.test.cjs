const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { ROOT_CONTEXT, createContextKey } = require('@opentelemetry/api');
const { ContextManager } = require('../dist/index.js');

test('bound emitters release once listeners and preserve removeListener identity', () => {
  const manager = new ContextManager().enable();
  const emitter = new EventEmitter();
  const key = createContextKey('audit');
  const context = ROOT_CONTEXT.setValue(key, 'scope');
  manager.bind(context, emitter);
  let called = 0;
  const listener = () => { called++; assert.equal(manager.active().getValue(key), 'scope'); };
  emitter.once('work', listener);
  emitter.emit('work');
  assert.equal(called, 1);
  assert.equal(emitter.listenerCount('work'), 0);
  emitter.on('work', listener);
  emitter.removeListener('work', listener);
  assert.equal(emitter.listenerCount('work'), 0);
  manager.bind(context, emitter);
  emitter.prependOnceListener('work', listener);
  emitter.emit('work');
  assert.equal(emitter.listenerCount('work'), 0);
  manager.disable();
});
