const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { gunzipSync } = require('node:zlib');
const path = require('node:path');
const protobuf = require('protobufjs');
const schema = protobuf.parse('syntax="proto3"; message Span { string name=5; } message ScopeSpans { repeated Span spans=2; } message ResourceSpans { repeated ScopeSpans scopeSpans=2; } message Traces { repeated ResourceSpans resourceSpans=1; } message Metric { string name=1; } message ScopeMetrics { repeated Metric metrics=2; } message ResourceMetrics { repeated ScopeMetrics scopeMetrics=2; } message Metrics { repeated ResourceMetrics resourceMetrics=1; }').root;

test('shutdown/reinit exports actual traces and metrics to each new destination across CJS/ESM generations', async () => {
  const collectors = [];
  try {
    for (let i = 0; i < 2; i++) {
      const received = { spans: [], metrics: [] };
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          let body = Buffer.concat(chunks);
          if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
          if (req.url.endsWith('/v1/traces')) {
            const decoded = schema.lookupType('Traces').decode(body);
            received.spans.push(...decoded.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans.map(s => s.name))));
          } else if (req.url.endsWith('/v1/metrics')) {
            const decoded = schema.lookupType('Metrics').decode(body);
            received.metrics.push(...decoded.resourceMetrics.flatMap(r => r.scopeMetrics.flatMap(s => s.metrics.map(m => m.name))));
          }
          res.setHeader('content-type', 'application/x-protobuf');
          res.end();
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      collectors.push({ server, received, endpoint: `http://127.0.0.1:${server.address().port}` });
    }
    const program = `(async()=>{
      const api=require('@opentelemetry/api');
      const cjs=require('./dist/index.js'),esm=await import('./dist/index.mjs');
      const endpoints=${JSON.stringify(collectors.map(c => c.endpoint))};let previous;
      for(let i=0;i<4;i++){
        const owner=i%2?esm:cjs;
        const h=await owner.initObservability({autoShutdown:false,service:{serviceName:'restart-'+i},exporters:{url:endpoints[i%2]},tracing:{enabled:true,sampling:{ratio:1}},metrics:{enabled:true,exportIntervalMillis:60000},instrumentations:{http:{enabled:true}}});
        if(!h.isStarted())throw new Error('Unstarted generation '+i);
        if(previous)await previous.shutdown();
        const http=require('node:http');let incomingTrace;
        const app=http.createServer((_req,res)=>{incomingTrace=api.trace.getActiveSpan()?.spanContext().traceId;res.end('ok');});
        await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
        await h.tracer.withSpan('generation-'+i,async span=>{
          await Promise.resolve();if(api.trace.getActiveSpan()?.spanContext().spanId!==span.spanContext().spanId)throw new Error('Lost async parent context');
          await new Promise((resolve,reject)=>http.get('http://127.0.0.1:'+app.address().port+'/generation-'+i,res=>{res.resume();res.on('end',resolve);}).on('error',reject));
          if(incomingTrace!==span.spanContext().traceId)throw new Error('HTTP propagation lost in generation '+i+' (incoming active span: '+!!incomingTrace+')');
        });
        app.closeAllConnections();await new Promise(resolve=>app.close(resolve));
        h.metrics.increment('generation_counter_'+i);
        await h.forceFlush();await h.shutdown();previous=h;
      }
    })().catch(e=>{console.error(e);process.exit(1)});`;
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, ['-e', program], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, OTEL_TRACES_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'otlp', OTEL_LOGS_EXPORTER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.stdout.resume(); child.stderr.on('data', chunk => stderr += chunk);
      child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stderr }); });
    });
    assert.equal(result.status, 0, `${result.signal}: ${result.stderr}`);
    for (let i = 0; i < 4; i++) {
      assert.ok(collectors[i % 2].received.spans.includes('generation-' + i), 'Missing exported span for generation ' + i);
      assert.ok(collectors[i % 2].received.metrics.includes('generation_counter_' + i), 'Missing exported metric for generation ' + i);
      assert.ok(!collectors[(i + 1) % 2].received.spans.includes('generation-' + i), 'Exported to stale destination');
    }
    for (const { received } of collectors) assert.ok(received.spans.includes('GET'), 'Missing HTTP instrumentation');
  } finally {
    for (const { server } of collectors) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});

for (const signal of ['trace', 'metrics']) {
  test(`foreign ${signal} registration rejects startup without shutting down its provider`, () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', `(async()=>{
      const api=require('@opentelemetry/api');let destroyed=0;
      const provider=${signal === 'trace' ? "{getTracer:()=>new api.ProxyTracerProvider().getTracer('foreign'),shutdown:async()=>{destroyed++;}}" : "{getMeter:()=>api.createNoopMeter(),shutdown:async()=>{destroyed++;}}"};
      ${signal === 'trace' ? 'api.trace.setGlobalTracerProvider(provider);const before=api.trace.getTracerProvider();' : 'api.metrics.setGlobalMeterProvider(provider);const before=api.metrics.getMeterProvider();'}
      const sdk=require('./dist/index.js'),config={autoShutdown:false,service:{serviceName:'foreign'},tracing:{enabled:true},metrics:{enabled:true},instrumentations:false};
      let rejected=false;try{await sdk.initObservability(config);}catch(e){rejected=/global provider/.test(e.message);}
      if(!rejected)throw new Error('Foreign provider collision returned healthy');
      const fallback=await sdk.initObservability({...config,failOpen:true});
      if(fallback.isStarted())throw new Error('Fail-open collision returned healthy');
      if(destroyed||${signal === 'trace' ? 'api.trace.getTracerProvider()' : 'api.metrics.getMeterProvider()'}!==before)throw new Error('Foreign provider was removed or destroyed');
    })().catch(e=>{console.error(e);process.exitCode=1});`], { cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:10000,env:{...process.env,OTEL_TRACES_EXPORTER:'console',OTEL_METRICS_EXPORTER:'otlp',OTEL_EXPORTER_OTLP_ENDPOINT:'http://127.0.0.1:9',OTEL_EXPORTER_OTLP_TIMEOUT:'50'} });
    assert.equal(result.status,0,result.stderr);
  });
}

test('shutdown does not remove replacement foreign trace and metric providers', () => {
  const { spawnSync }=require('node:child_process');
  const result=spawnSync(process.execPath,['-e',`(async()=>{
    const api=require('@opentelemetry/api');
    const h=await require('./dist/index.js').initObservability({autoShutdown:false,service:{serviceName:'replacement'},tracing:{enabled:true},metrics:{enabled:true},instrumentations:false});
    api.trace.disable();api.metrics.disable();
    const tracer={getTracer:()=>new api.ProxyTracerProvider().getTracer('foreign')},meter={getMeter:()=>api.createNoopMeter()};
    api.trace.setGlobalTracerProvider(tracer);api.metrics.setGlobalMeterProvider(meter);const registered=api.trace.getTracerProvider();
    await h.shutdown();if(api.trace.getTracerProvider()!==registered||api.metrics.getMeterProvider()!==meter)throw new Error('Replacement provider removed');
  })().catch(e=>{console.error(e);process.exitCode=1});`],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:10000,env:{...process.env,OTEL_TRACES_EXPORTER:'console',OTEL_METRICS_EXPORTER:'otlp',OTEL_EXPORTER_OTLP_ENDPOINT:'http://127.0.0.1:9',OTEL_EXPORTER_OTLP_TIMEOUT:'50'}});
  assert.equal(result.status,0,result.stderr);
});
