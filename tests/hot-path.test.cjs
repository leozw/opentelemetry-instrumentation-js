const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function source(file, mocks = {}) {
  if (file === 'instrumentations/index.ts') {
    delete globalThis[Symbol.for('elven.observability.node.instrumentations.v1')];
    mocks['./config'] ??= source('instrumentations/config.ts');
  }
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', code)(name => mocks[name] || require(name), exports);
  return exports;
}
test('copy-on-write redaction preserves frozen originals and sanitizes URL/event/link secrets', () => {
  const { RedactingSpanExporter } = source('core/exporter/RedactingSpanExporter.ts');
  let exported;
  const exporter = new RedactingSpanExporter({ export: spans => { exported = spans; } }, { redactDbStatement: true, hashUserId: true, allowRawAttributes: [] });
  const clean = Object.freeze({ attributes: Object.freeze({ method: 'GET' }), events: [], links: [] });
  const dirty = Object.freeze({ attributes: Object.freeze({ 'db.user': 'username', 'url.full': 'https://user:password@example.test/p?q=secret#private' }),
    events: [Object.freeze({ name: 'event', attributes: Object.freeze({ 'db.statement': 'SQL', 'user.id': 'private-id' }) })],
    links: [Object.freeze({ attributes: Object.freeze({ 'http.request.header.authorization': 'secret' }) })] });
  exporter.export([clean, dirty], () => {});
  assert.equal(exported[0], clean);
  assert.notEqual(exported[1], dirty);
  assert.equal(dirty.attributes['db.user'], 'username');
  assert.equal(exported[1].attributes['db.user'], '[REDACTED]');
  assert.equal(exported[1].attributes['url.full'], 'https://example.test/p?[REDACTED]');
  assert.equal(exported[1].events[0].attributes['db.statement'], '[REDACTED]');
  assert.match(exported[1].events[0].attributes['user.id'], /^[a-f0-9]{16}$/);
  assert.equal(exported[1].links[0].attributes['http.request.header.authorization'], '[REDACTED]');
  exporter.export([{ attributes: { 'http.target': '/p?x=secret', 'http.url': 'http://[invalid' }, events: [], links: [] }], () => {});
  assert.equal(exported[0].attributes['http.target'], '/p?[REDACTED]');
  assert.equal(exported[0].attributes['http.url'], '[REDACTED]');
});
test('payload limiter keeps scalar/array boundaries and rejects aggregate event/link payloads', () => {
  const { SpanPayloadLimitProcessor } = source('core/tracing/SpanPayloadLimitProcessor.ts');
  const accepted = [];
  const processor = new SpanPayloadLimitProcessor({ onEnd: span => accepted.push(span) });
  const span = attributes => ({ name: 'span', status: {}, attributes, events: [], links: [] });
  const scalar = span({ a: 1, b: true, c: 'text' });
  const array = span({ a: Array(64).fill('x') });
  processor.onEnd(scalar); processor.onEnd(array);
  processor.onEnd(span({ a: Array(65).fill('x') }));
  processor.onEnd({ ...span({}), events: [{ name: 'e', attributes: { huge: 'x'.repeat(33000) } }] });
  processor.onEnd({ ...span({}), links: [{ attributes: { huge: 'x'.repeat(33000) } }] });
  assert.deepEqual(accepted, [scalar, array]);
});
test('redaction retains clean event/link arrays and copies only changed items', () => {
  const { RedactingSpanExporter } = source('core/exporter/RedactingSpanExporter.ts');
  let exported;
  const exporter = new RedactingSpanExporter({ export: spans => { exported = spans; } }, { redactDbStatement: true, hashUserId: true, allowRawAttributes: [] });
  const clean = Object.freeze({ name: 'clean', attributes: Object.freeze({ method: 'GET' }) });
  const dirty = Object.freeze({ name: 'dirty', attributes: Object.freeze({ 'db.user': 'private' }) });
  const events = Object.freeze([clean, dirty, clean]);
  const links = Object.freeze([clean]);
  const span = Object.freeze({ attributes: Object.freeze({}), events, links });
  exporter.export([span], () => {});
  assert.equal(exported[0].links, links);
  assert.notEqual(exported[0].events, events);
  assert.equal(exported[0].events[0], clean);
  assert.equal(exported[0].events[2], clean);
  assert.equal(exported[0].events[1].attributes['db.user'], '[REDACTED]');
  assert.equal(dirty.attributes['db.user'], 'private');
});
test('HTTP body histograms remain lazy and record valid content lengths including zero', () => {
  let config;
  let created = 0;
  const records = [];
  const { getCoreInstrumentations } = source('instrumentations/index.ts', {
    '@opentelemetry/api': { metrics: { getMeter: () => ({ createHistogram: name => { created++; return { record: (value, attrs) => records.push({ name, value, attrs }) }; } }) } },
    '@opentelemetry/auto-instrumentations-node': { getNodeAutoInstrumentations: () => [{
      instrumentationName: '@opentelemetry/instrumentation-http', getConfig: () => ({ enabled: true }),
      setConfig: value => { config = { '@opentelemetry/instrumentation-http': value }; }, enable: () => {}, disable: () => {},
    }] },
    './registry': { getAutoInstrumentationsConfig: () => ({ '@opentelemetry/instrumentation-http': { enabled: true } }) },
  });
  getCoreInstrumentations({ privacy: {} });
  const hook = config['@opentelemetry/instrumentation-http'].applyCustomAttributesOnSpan;
  hook({}, { headers: {}, method: 'GET' }, { statusCode: 200, getHeader: () => undefined });
  assert.equal(created, 0);
  hook({}, { headers: { 'content-length': '0' }, method: 'POST' }, { statusCode: 201, getHeader: () => '42' });
  assert.equal(created, 2);
  assert.deepEqual(records.map(r => r.value), [42, 0]);
  assert.deepEqual(records[0].attrs, { 'http.request.method': 'POST', 'http.response.status_code': 201 });
});

test('unselected upstream instrumentations cannot leave constructor-enabled hooks active', () => {
  let disabled=0;
  const selected={instrumentationName:'@opentelemetry/instrumentation-http',getConfig:()=>({enabled:true}),setConfig:()=>{},enable:()=>{},disable:()=>assert.fail('selected HTTP disabled')};
  const unknown={instrumentationName:'@opentelemetry/instrumentation-unselected',getConfig:()=>({enabled:true}),disable:()=>{disabled++;}};
  const {getCoreInstrumentations}=source('instrumentations/index.ts',{
    '@opentelemetry/auto-instrumentations-node':{getNodeAutoInstrumentations:()=>[selected,unknown]},
    './registry':{getAutoInstrumentationsConfig:()=>({'@opentelemetry/instrumentation-http':{enabled:true}})},
  });
  assert.deepEqual(getCoreInstrumentations({privacy:{}}),[selected]);
  assert.equal(disabled,1);
});

test('restart reuses bounded instrumentation instances and reapplies the new configuration', () => {
  let constructions=0,enabled=0,disabled=0,current={enabled:true};
  const http={instrumentationName:'@opentelemetry/instrumentation-http',getConfig:()=>current,setConfig:value=>{current=value;},enable:()=>{enabled++;},disable:()=>{disabled++;}};
  const {getCoreInstrumentations}=source('instrumentations/index.ts',{
    '@opentelemetry/auto-instrumentations-node':{getNodeAutoInstrumentations:()=>{constructions++;return[http];}},
    './registry':{getAutoInstrumentationsConfig:options=>({'@opentelemetry/instrumentation-http':{enabled:options.config?.http?.enabled!==false}})},
  });
  const first=getCoreInstrumentations({privacy:{},config:{http:{enabled:true}}});
  assert.deepEqual(getCoreInstrumentations({privacy:{},config:{http:{enabled:false}}}),[]);
  const third=getCoreInstrumentations({privacy:{},config:{http:{enabled:true}}});
  assert.equal(first[0],third[0]);assert.equal(constructions,1);assert.equal(disabled,1);assert.equal(enabled,2);
});
