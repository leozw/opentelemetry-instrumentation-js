# Elven OpenTelemetry Instrumentation JS

Unreleased optional major candidate: `2.0.0`, intended for the `next` channel.
This dirty source continuation is not a frozen or qualified package. Historical
`1.0.9` audit artifacts remain separate; no existing user is automatically upgraded.

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

This optional major targets Node >=22.0.0, not the previous 1.x runtime contract.
Minimum/current-runtime qualification is pending. Use a maintained patched Node;
development tools may require a newer version than the production package.
See [Node releases](https://nodejs.org/en/about/previous-releases).

This candidate keeps OTel `2.12.x` / `0.223.x` and auto-instrumentations
`0.81.x`; an OTel major migration is separate. Experimental OTel ranges are restricted to one minor
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
`OTEL_SDK_DISABLED=true` is intentional no-op initialization, not a startup
failure, including with `failOpen: false`. It uses the upstream parser (trimmed,
case-insensitive `true`), constructs no active exporters/readers/hooks and does
not use or alter foreign providers. The initialized disabled handle reports
`isStarted() === true` until shutdown; that describes its lifecycle, not active
export. Its no-op facades still execute business callbacks. Set the flag before
initialization; changing environment variables does not stop an existing owner.
See the [standard SDK disable setting](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#general-sdk-configuration).
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
cardinality. Known-key redaction covers span, event, link, Resource and custom
MetricFacade attribute maps, without mutating callers. Ordinary dimensions and
measurement context are retained. This deliberately fixes raw sensitive values;
explicit privacy opt-outs remain available. It is not a general PII filter for
span names, exception messages, scope metadata or arbitrary user-defined strings.
Spans cap attribute string values at 4096 characters, 128 span attributes,
64 events/links and 64 attributes per event/link. A payload guard drops spans
over a charged 65,536-byte span budget or with attribute arrays over 64 values
before queueing. Its separate owned Resource budget is 131,072 bytes including
schema URL; these are not a single serialized-envelope or process RSS guarantee.
Oversized/malformed spans are dropped with fixed diagnostics and saturating
accounting. Large application
objects can still allocate before being handed to OpenTelemetry.

### Optional Major Config And Lifecycle Policy

Active startup admits a detached descriptor-based config before field reads.
Own enumerable string keys are copied; hidden/symbol keys are ignored, enumerable
getters, cycles and class instances are rejected. Callbacks retain opaque identity;
RegExp source/flags use intrinsics without reading caller accessors or lastIndex.
The config admission ceiling is 1 MiB charged data, 4096 values, 512 containers,
depth 12 and 65,536 UTF-16 units per string. This is not a Proxy sandbox, a bound
on application allocation or a general executable-callback retention guarantee.
Sampler rules remain capped at 32, keys at 128 and literals at 4096 units; custom
regex uses the bounded engine policy without native fallback. This distribution
has Node-only root/preload exports and Node 22+ dependencies, including Buffer;
it does not provide a browser entry, browser qualification or browser polyfill.
Defaults keep
ParentBased sampling and avoid allocating custom matcher backends.

Programmatic metric intervals/timeouts must be finite in 1..300000 ms; cardinality
must be a safe integer in 2..100000 and export batch size in 1..100000. Malformed
config rejects startup unless an own data `failOpen: true` requests an unstarted
no-op handle. Global `OTEL_SDK_DISABLED=true` is checked first, even before service
getters, and returns a successful isolated no-op handle. Both explicit signal
disable flags, individually or together, use isolated no-op providers for the
disabled signal, never a foreign application provider. HTTP body-size hooks use
the same selected meter. Instrumentations are registered once after requested
provider startup succeeds, with explicit owned/no-op signal bindings.
Hot global disable affects the new initialization call only: an already active
generation remains its owner's responsibility and requires that handle's shutdown.
Duplicate active initialization still reuses that generation and ignores new config.
Startup rollback tracks components created before provider registration; shutdown
only unregisters still-current owned trace/meter identities. Callback errors retain
their original identity even if span recording or ending fails.

The runtime does not create or register a logger provider. Logger correlation
may consult the application's logging API; it does not own that provider's
shutdown. Application diagnostic logger configuration remains application-owned;
this composition does not install a diagnostic logger from `OTEL_LOG_LEVEL`.
Context and W3C trace-context/baggage propagation use a lazy, register-only shared
process bootstrap. Existing foreign registrations are not replaced or disabled.
After pipeline shutdown the bootstrap may remain registered for process lifetime;
no zero-overhead or full-global-restoration guarantee is made. Internal explicit
null propagation means do not register a propagator, not disable a foreign one.

Resource behavior is unchanged from the archived public 1.0.8 path: explicit
service/host/process/runtime fields and configured Resource attributes pass through
the existing privacy policy. That path disables automatic NodeSDK resource/env
detectors, so it does not ingest `OTEL_RESOURCE_ATTRIBUTES` or add detector results.
Provider composition does not silently turn those detectors on. The six span
limits, owned DTO guards, sampler, metric readers/views, ordinary dimensions,
measurement context and exemplar behavior are retained; new qualification is
still required and no performance or browser acceptance is implied.

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
```

The existing benchmark is historical source, not the optional-major acceptance
gate. Do not replay it as SDK2 qualification. The new gate requires <=5% latency
AND throughput regression versus an exact current public archive (expected 1.0.8,
subject to fresh metadata verification), on the same runtime/config/capture.
Bare HTTP is a separately reported reference. A fresh bounded controller,
decoded capture/counter reconciliation, high-resolution quantiles and aggregation,
an immutable candidate and an explicit quiet-window approval are required first.
No SDK2 performance execution or acceptance has occurred.

The preserved older benchmark requires active HTTP trace and metric export;
disabling both signals is not an instrumentation benchmark.
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

Historical 1.x qualification was blocked: hosted run `40940552957` at `fd41733` failed the
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

Development uses the existing locked toolchain; its runtime requirements are
separate from the optional-major production floor. SDK2 emits a Node 22 target.
Historical CI and quantized/shared-host measurements are not new SDK2 proof or
universal overhead guarantees. The existing release workflow is not approval
to publish this optional major; its packed, security, compatibility, independent
review and new public-relative performance gates remain pending.
