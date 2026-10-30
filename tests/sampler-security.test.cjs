const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
function child(source) {
  const result = spawnSync(process.execPath, ['-e', source], { cwd: root, env: { ...env, OTEL_TRACES_EXPORTER: 'console', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' }, encoding: 'utf8', timeout: 2500 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal((result.stderr + result.stdout).includes('SYNTHETIC_INLINE_PRIVATE_773'), false);
}
const setup = `const assert=require('node:assert/strict');const config={service:{serviceName:'sampler-security'},autoShutdown:false,instrumentations:false,tracing:{enabled:true},metrics:{enabled:false}};`;
for (const format of ['cjs', 'esm']) for (const apiName of ['startSpan', 'withSpan']) {
  test(`bounded actual ${format} ${apiName} accepts formerly catastrophic rules without mutating RegExp`, () => child(`${setup}
    (async()=>{const sdk=${format === 'cjs' ? "require('./dist/index.js')" : "await import('./dist/index.mjs')"};
    const pattern=/(a|aa)+b/;pattern.lastIndex=17;pattern.test=()=>{throw new Error('CALLER_REGEXP_TEST_MUST_NOT_RUN');};Object.freeze(pattern);
    config.tracing.sampling={ratio:1,rules:[{attributeKey:'audit.route',attributeValue:pattern,decision:0}]};
    const handle=await sdk.initObservability(config);assert.equal(handle.isStarted(),true);
    for(const size of [64,4096,65536]){const options={attributes:{'audit.route':'b'+'a'.repeat(size)}};
      ${apiName === 'startSpan' ? "const span=handle.tracer.startSpan('safe-sampler',options);assert.equal(span.isRecording(),true);span.end();" : "let ran=false;handle.tracer.withSpan('safe-sampler',span=>{ran=true;assert.equal(span.isRecording(),true);},options);assert.equal(ran,true);"}
    }
    assert.equal(pattern.lastIndex,17);await handle.shutdown();})();`));
  test(`certified native ${format} ${apiName} rejects malformed UTF-16 before ratio fallback`, () => child(`${setup}
    (async()=>{const sdk=${format === 'cjs' ? "require('./dist/index.js')" : "await import('./dist/index.mjs')"};
    config.tracing.sampling={ratio:1,rules:[{attributeKey:'audit.route',attributeValue:/token/i,decision:2}]};
    const handle=await sdk.initObservability(config);
    for(const broken of ['\\ud800','\\udc00']){const options={attributes:{'audit.route':broken+'ordinary-native-input'}};
      ${apiName === 'startSpan' ? "const span=handle.tracer.startSpan('native-unsupported',options);assert.equal(span.isRecording(),false);span.end();" : "let ran=false;handle.tracer.withSpan('native-unsupported',span=>{ran=true;assert.equal(span.isRecording(),false);},options);assert.equal(ran,true);"}
    }
    await handle.shutdown();})();`));
}
for (const [name, pattern] of [['lookahead', '/(?=SYNTHETIC_INLINE_PRIVATE_773)x/'], ['backref', '/(a)\\1/'], ['property', '/\\p{Letter}+/u']]) {
  test(`strict unsupported ${name} is value-free startup rejection; explicit failOpen continues`, () => child(`${setup}
    (async()=>{const sdk=require('./dist/index.js');config.tracing.sampling={rules:[{attributeKey:'audit.route',attributeValue:${pattern},decision:0}]};
    await assert.rejects(sdk.initObservability({...config,failOpen:false}),error=>error.message==='ELVEN_MATCHER_UNSUPPORTED_PATTERN');
    const noop=await sdk.initObservability({...config,failOpen:true});assert.equal(noop.isStarted(),false);await noop.shutdown();})();`));
}
test('normal exact strings and regex preserve configured decisions and copied rules', () => child(`${setup}
  (async()=>{const sdk=require('./dist/index.js');const rule={attributeKey:'audit.route',attributeValue:/^private$/g,decision:0};rule.attributeValue.lastIndex=19;
  config.tracing.sampling={ratio:1,rules:[rule,{attributeKey:'audit.kind',attributeValue:'literal',decision:0}]};
  const handle=await sdk.initObservability(config);rule.attributeKey='changed';
  for(const attributes of [{'audit.route':'private'},{'audit.kind':'literal'}]){const span=handle.tracer.startSpan('normal-sampler',{attributes});assert.equal(span.isRecording(),false);span.end();}
  const span=handle.tracer.startSpan('ordinary-sampler',{attributes:{'audit.route':'ordinary'}});assert.equal(span.isRecording(),true);span.end();
  assert.equal(rule.attributeValue.lastIndex,19);await handle.shutdown();})();`));
test('unsupported live input drops sampling with fixed diagnostics rather than throwing', () => child(`${setup}
  (async()=>{const sdk=require('./dist/index.js');config.tracing.sampling={ratio:1,rules:[{attributeKey:'audit.route',attributeValue:/./u,decision:2}]};
  const handle=await sdk.initObservability(config);const span=handle.tracer.startSpan('surrogate',{attributes:{'audit.route':'\\ud800'}});assert.equal(span.isRecording(),false);span.end();await handle.shutdown();})();`));
test('over-limit rule counts fail before inspecting array elements', () => child(`${setup}
  (async()=>{const sdk=require('./dist/index.js');const rules=new Array(33);Object.defineProperty(rules,0,{get(){throw new Error('MUST_NOT_VISIT');}});config.tracing.sampling={rules};
  await assert.rejects(sdk.initObservability(config),error=>error.message==='ELVEN_SAMPLER_RULE_BUDGET');})();`));
test('no-custom-rule sampler does not load regex backends and shutdown/reinit keeps it functional', () => child(`${setup}
  (async()=>{const sdk=require('./dist/index.js');config.tracing.sampling={ratio:1};for(let i=0;i<2;i++){const handle=await sdk.initObservability(config);const span=handle.tracer.startSpan('default-control');assert.equal(span.isRecording(),true);span.end();await handle.shutdown();}
  assert.equal(require.cache[require.resolve('re2js')],undefined);assert.equal(require.cache[require.resolve('@eslint-community/regexpp')],undefined);})();`));
