const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cwd = path.resolve(__dirname, '..');
const environment = disabled => ({ ...process.env, NODE_OPTIONS: '', OTEL_SDK_DISABLED: disabled, OTEL_TRACES_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'otlp', OTEL_LOGS_EXPORTER: 'none' });

test('SDK09 strict direct init accepts intentional disable without a provider conflict', () => {
  const result=spawnSync(process.execPath,['-e',`(async()=>{const h=await require('./dist/index.js').initObservability({failOpen:false,service:{serviceName:'direct-disabled'},tracing:{enabled:true},metrics:{enabled:true},exporters:{url:'http://127.0.0.1:9'}});if(!h.isStarted())throw new Error('Disabled initialization was degraded');await h.forceFlush();await h.shutdown();})().catch(e=>{console.error(e);process.exitCode=1});`],{cwd,env:environment('true'),encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
});

for (const disabled of ['true', 'TRUE', 'TrUe', ' true ']) {
  for (const failOpen of [false, true, undefined]) {
    test(`intentional global disable ${JSON.stringify(disabled)} resolves with failOpen=${failOpen}`, () => {
      const program = `(async()=>{
        const api=require('@opentelemetry/api');let foreignCalls=0,destroyed=0,registrations=0;
        const foreignTrace={getTracer:()=>{foreignCalls++;return new api.ProxyTracerProvider().getTracer('foreign');},shutdown:async()=>{destroyed++;}};
        const foreignMeter={getMeter:()=>{foreignCalls++;return api.createNoopMeter();},shutdown:async()=>{destroyed++;}};
        api.trace.setGlobalTracerProvider(foreignTrace);api.metrics.setGlobalMeterProvider(foreignMeter);
        for(const [owner,method]of [[api.trace,'setGlobalTracerProvider'],[api.metrics,'setGlobalMeterProvider'],[api.context,'setGlobalContextManager'],[api.propagation,'setGlobalPropagator']]){
          const original=owner[method].bind(owner);owner[method]=(...args)=>{registrations++;return original(...args);};
        }
        const cjs=require('./dist/index.js'),esm=await import('./dist/index.mjs');
        const beforeTrace=api.trace.getTracerProvider(),beforeMeter=api.metrics.getMeterProvider(),beforeCalls=foreignCalls;
        const beforeSignals=process.listenerCount('SIGTERM');
        const config={failOpen:${JSON.stringify(failOpen)},autoShutdown:true,service:{serviceName:'disabled'},tracing:{enabled:true},metrics:{enabled:true},
          get exporters(){throw new Error('Disabled startup constructed an active exporter');},get instrumentations(){throw new Error('Disabled startup constructed instrumentation');}};
        const [a,b]=await Promise.all([cjs.initObservability(config),esm.initObservability(config)]);
        if(a!==b||!a.isStarted())throw new Error('Intentional disable was treated as failed/degraded startup');
        let callbacks=0;
        a.tracer.withSpan('disabled-sync',span=>{if(span.isRecording())throw new Error('Disabled span records');callbacks++;});
        await a.tracer.withSpan('disabled-async',async()=>{await Promise.resolve();callbacks++;});
        a.metrics.increment('disabled_counter');a.metrics.recordHistogram('disabled_histogram',1);
        await a.forceFlush();await a.shutdown();
        if(a.isStarted()||callbacks!==2)throw new Error('Disabled handle lifecycle/business callback failed');
        if(registrations||foreignCalls!==beforeCalls||destroyed)throw new Error('Disabled startup touched an active signal pipeline');
        if(api.trace.getTracerProvider()!==beforeTrace||api.metrics.getMeterProvider()!==beforeMeter)throw new Error('Foreign globals changed');
        if(process.listenerCount('SIGTERM')!==beforeSignals||globalThis[Symbol.for('elven.observability.node.instrumentations.v1')])throw new Error('Disabled startup installed hooks');
        if(process.env.OTEL_SDK_DISABLED!==${JSON.stringify(disabled)})throw new Error('Environment mutated');
      })().catch(e=>{console.error(e);process.exitCode=1});`;
      const result=spawnSync(process.execPath,['-e',program],{cwd,env:environment(disabled),encoding:'utf8',timeout:10000});
      assert.equal(result.status,0,result.stderr);
    });
  }
}

for (const disabled of ['false', 'FALSE', '', '1', 'yes']) {
  test(`non-true global disable ${JSON.stringify(disabled)} retains foreign-provider conflict checks`, () => {
    const program=`(async()=>{
      const api=require('@opentelemetry/api');let destroyed=0;
      api.trace.setGlobalTracerProvider({getTracer:()=>new api.ProxyTracerProvider().getTracer('foreign'),shutdown:async()=>{destroyed++;}});
      const before=api.trace.getTracerProvider();let rejected=false;
      try{await require('./dist/index.js').initObservability({failOpen:false,autoShutdown:false,service:{serviceName:'conflict'},tracing:{enabled:true},metrics:{enabled:false},instrumentations:false});}
      catch(error){rejected=/could not register its global provider/.test(error.message);}
      if(!rejected||destroyed||api.trace.getTracerProvider()!==before)throw new Error('Active foreign-provider conflict was bypassed');
    })().catch(e=>{console.error(e);process.exitCode=1});`;
    const result=spawnSync(process.execPath,['-e',program],{cwd,env:{...environment(disabled),OTEL_TRACES_EXPORTER:'console'},encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
  });
}

test('disabled zero-code preload continues application work without active startup warnings', () => {
  const result=spawnSync(process.execPath,['--require','./dist/preload.js','-e',`setImmediate(async()=>{const p=require('./dist/index.js');const h=await p.initObservability({failOpen:false,service:{serviceName:'disabled-preload'},tracing:{enabled:true},metrics:{enabled:true}});let calls=0;h.tracer.withSpan('business',()=>calls++);await h.shutdown();if(calls!==1)process.exitCode=1;});`],{cwd,env:{...environment('TrUe'),OTEL_ZERO_CODE:'true',OTEL_EXPORTER_OTLP_ENDPOINT:'not-a-url'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.doesNotMatch(result.stderr,/Failed to initialize|could not register|Invalid URL/);
});
