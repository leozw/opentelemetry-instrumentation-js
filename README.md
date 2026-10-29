# Elven OpenTelemetry Instrumentation JS

Candidate package version: `1.0.9` (not published by this audit). The earlier
"v2" headings describe the API design, not an npm `2.x` release.

Official [Node.js integration guide](https://docs.elven.works/elven-observability/integracao-e-instrumentacao/javascript/instrumentacao-node.js-com-elven-observability.html)
and [documentation source](https://github.com/elvenworks-ps/docs.elven.works).

Node-first OpenTelemetry bootstrap for JavaScript services, focused on:

- deterministic startup/shutdown lifecycle
- explicit feature toggles (`tracing`, `metrics`, `instrumentations`)
- strict privacy defaults (`db.statement` redaction + `user.id` hashing)
- OTLP exporter compatibility without vendor lock-in
- log correlation only (no log-export pipeline inside this package)

## Installation

```bash
npm install elven-opentelemetry-instrumentation-js
```

## Runtime support

The compatibility floor is `^18.19.0 || >=20.6.0`, matching OTel 2.x.
Node 18 and 20 are EOL: compatibility is not security support. Use a maintained,
patched Node 22, 24 or 26 release. Development tools may require a newer Node
than the production package. See [Node releases](https://nodejs.org/en/about/previous-releases).

This patch deliberately uses OTel `2.12.x` / `0.223.x` and auto-instrumentations
`0.81.x`. The latest generation, OTel `3.x` / `0.300.x`, requires Node >=22.15.0
and a separate migration. Experimental OTel ranges are restricted to one minor
generation; package-lock.json records the audited development graph.

v2 supports `runtime: 'node'` only.

Passing `runtime: 'serverless'` or `runtime: 'edge'` throws an explicit error.

## Zero-code preload

```bash
export OTEL_SERVICE_NAME="my-service"
export OTEL_SERVICE_VERSION="1.0.0"
node --require elven-opentelemetry-instrumentation-js/preload app.js
```

Disable preload initialization explicitly:

```bash
export OTEL_ZERO_CODE=false
```

## Manual initialization

```typescript
import { initObservability } from 'elven-opentelemetry-instrumentation-js';

const observability = await initObservability({
  runtime: 'node',
  autoShutdown: true,
  service: {
    serviceName: 'my-payment-service',
    serviceVersion: '1.0.0',
    deploymentEnvironment: 'production',
  },
  exporters: {
    protocol: 'http/protobuf', // or 'grpc'
    url: 'https://otel.example.com/otlp', // base URL; signal paths are appended
    // tracesUrl and metricsUrl can override exact gateway routes per signal.
    compression: 'gzip',
  },
  tracing: {
    enabled: true,
    sampling: {
      ratio: 0.1,
    },
  },
  metrics: {
    enabled: true,
    exportIntervalMillis: 60000,
    exportTimeoutMillis: 10000,
    cardinalityLimit: 500,
    maxExportBatchSize: 512,
  },
  privacy: {
    redactDbStatement: true,
    hashUserId: true,
    allowRawAttributes: [],
  },
  instrumentations: {
    http: { enabled: true },
    express: { enabled: true },
    pg: { enabled: true },
    pino: { enabled: true },
    winston: { enabled: true },
  },
});

await observability.forceFlush();
await observability.shutdown();
```

## Public API (1.x)

`initObservability(config)` returns an `ObservabilityHandle`:

- `tracer`
- `metrics`
- `shutdown(): Promise<void>`
- `forceFlush(): Promise<void>`
- `isStarted(): boolean`

The initializer is idempotent and protects against duplicate concurrent startup.
The first configuration wins across CJS and ESM entrypoints in one isolate.
Startup failures reject by default (`failOpen: false`), including invalid exporter
configuration. `failOpen: true` returns a no-op handle with `isStarted() === false`;
it is not a successful component startup. Later network/export failures remain
asynchronous and are not startup failure proof. Existing 1.0.8 API names remain.
Preload skips Worker threads; initialize explicitly inside an application Worker
when needed. Child and cluster processes initialize independently, inheriting
`NODE_OPTIONS` and environment in the normal Node way. Internal log Workers do
not inherit preload options. Set `autoShutdown: false` when the application
owns shutdown and await `shutdown()` there. Automatic signal shutdown has a
10-second deadline and does not call `process.exit(0)` over application handlers.

After an awaited shutdown, a new init creates a new generation and may select a
new collector. Only still-current trace/metric providers registered by this SDK
are unregistered; foreign/replacement providers are not shut down or removed.
An occupied requested signal provider rejects startup (or returns an explicitly
unstarted handle with `failOpen: true`). Use the new handle/facades; old generation
tracers and instruments do not forward into a different collector. Instrumentation
instances are retained in a bounded per-isolate pool so already-loaded HTTP
modules can be repatched without accumulating require hooks.

### Exporter Header Ownership

Changing `exporters.url`, `tracesUrl` or `metricsUrl` does not create a credential
boundary. Upstream JS OTLP exporters merge ambient `OTEL_EXPORTER_OTLP_HEADERS`
and signal-specific header settings with programmatic `exporters.headers`;
setting `{}` is not a reliable way to clear unrelated ambient keys. Configure
collector URLs and headers as one trusted ownership boundary before startup.
Wrappers choosing an independent destination must guard or isolate that
configuration explicitly, not temporarily mutate shared `process.env`. This SDK
does not clear global environment variables or claim multi-owner credential
isolation. See [upstream OTLP configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/).

## Feature precedence

For booleans, precedence is:

1. explicit config
2. env var
3. package default

Examples:

- `OTEL_TRACES_EXPORTER=none` disables traces by default
- `tracing.enabled: true` overrides that default
- `OTEL_INSTR_PG=false` disables PG instrumentation unless explicitly enabled in config

Standard sampling variables are supported: `OTEL_TRACES_SAMPLER` and
`OTEL_TRACES_SAMPLER_ARG`. `OTEL_TRACES_SAMPLING_RATIO` remains available as a
convenience fallback. When none is configured, the package uses a 10% ratio.

## OTLP endpoints

For `http/protobuf`, a base endpoint appends `/v1/traces` and `/v1/metrics`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com/otlp
```

Gateways with custom routes should use exact signal-specific endpoints:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel.example.com/custom/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otel.example.com/custom/metrics
```

The default trace queue is 512 spans with batches of 128. Metrics default to a
60 second interval, 10 second timeout, 500-cardinality limit per instrument,
and export batches of 512. Standard OpenTelemetry batch processor environment
variables can override the trace limits.

MetricFacade retains at most 128 instrument names in total; use stable names,
not per-request names. Further names return no-op instruments and increment
`getDroppedInstruments()`. This is separate from per-instrument attribute
cardinality. Redaction covers span, event and link attribute maps, without
mutating the original span. It is not a general PII filter for span names,
exception messages, resource attributes or arbitrary user-defined strings.
Spans cap attribute string values at 4096 characters, 128 span attributes,
64 events/links and 64 attributes per event/link. A payload guard drops spans
over an estimated 64 KiB or with attribute arrays over 64 values before queueing.
These are telemetry drop limits, not process RSS guarantees; large application
objects can still allocate before being handed to OpenTelemetry.

The Node SDK log exporter is explicitly disabled in this package. Logs are
correlated with traces, but their shipping remains the responsibility of the
Elven logs interceptor.

## Auto-discovered instrumentations

Instrumentation is activated only when the target module is installed and enabled.

Supported:

- HTTP, Express, GraphQL (the current upstream auto bundle no longer includes Fastify)
- PostgreSQL, MySQL2, MongoDB, Mongoose
- Redis (`redis` and `ioredis`), Knex, generic-pool
- NestJS, Koa
- DNS, Net (default off)
- Pino and Winston (correlation only)

## Privacy defaults

Default privacy policy:

- redact `db.statement` and `db.query.text`
- hash `user.id` and `enduser.id`
- redact DB usernames, authorization/cookie attributes, URL credentials and query values
- allowlist raw attributes via `privacy.allowRawAttributes`

User ID hashing is deterministic pseudonymization, not irreversible anonymization.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run benchmark
```

The benchmark now requires actual HTTP trace and metric export to a local
collector; disabling both signals is not an instrumentation benchmark.
`npm run benchmark:ci` retains the existing 3% local comparison budget and p99
guard, and measures the documented p95 from microsecond HDR response samples.
Missing measurements fail closed. Shared CI and workstation results are noisy observations, not a
universal overhead guarantee. The existing CI budget remains enforced; a failed
budget is a performance-qualification blocker, not permission to waive the gate.
Set `BENCHMARK_PRELOAD_PATH` to compare another built/published package using
the same active-export harness.
Autocannon's summary does not expose p95; the public response event supplies the
raw samples used for p95. The retained integer-ms p99 check falls back to
throughput only when that measured latency is zero. Missing process samples
remain UNKNOWN.

Qualification is blocked: hosted run `40940552957` at `fd41733` failed the
unchanged 3% budget on Node 22/24/26. Active-export candidate p95 deltas against
bare HTTP were 309.45%, 344.91%, 335.25%; public 1.0.8 also failed (320.92%,
335.03%, 373.64%). The literal historical harness passed public 1.0.8 with both
exporters disabled and an absent p95 coerced to zero; that is not active-capture
qualification. No minimum-runtime, sampling, capture, privacy or dimension
reduction was accepted to obtain a pass. Do not promote this candidate while
the gate remains red. See [audit disposition](AUDIT.md).

## Maintainer Release Gates

The manual `.github/workflows/release.yml` accepts only `main`, an exact current
SHA, stable version and typed package confirmation. It requires successful
Node 22/24/26 main-push CI for that SHA, a public matching repository, a clean
production audit and the validated archive hash. Only the final hosted publish
job receives `NPM_TOKEN`; `id-token: write` and `--provenance` remain mandatory.
There are no push/tag publication triggers and no provenance fallback.

An authorized maintainer must configure `NPM_TOKEN` in this package's matching
GitHub repository before dispatch. No token was read, created or changed by the
audit, and trusted-publisher configuration is not assumed. A coordinator token
in another repository does not establish this package's provenance. This
workflow was prepared, not dispatched. See the [npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

Development builds use tsup 9 / esbuild 0.28.2 and require Node 22.18+, 24.11+
or 26+. This is a development-tool requirement, not a raised package runtime
floor; emitted code still targets Node 18.19. Performance qualification retains
the existing 3% gate. CI preserves published 1.0.8, the immutable audited
reference and the candidate, with original-harness results and separate-process
collector/CPU receipts. Quantized p99 and shared-host samples are not universal
overhead guarantees.
