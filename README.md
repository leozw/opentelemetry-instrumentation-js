# OpenTelemetry Instrumentation JS (v2)

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

## Public API (v2)

`initObservability(config)` returns an `ObservabilityHandle`:

- `tracer`
- `metrics`
- `shutdown(): Promise<void>`
- `forceFlush(): Promise<void>`
- `isStarted(): boolean`

The initializer is idempotent and protects against duplicate concurrent startup.

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

The Node SDK log exporter is explicitly disabled in this package. Logs are
correlated with traces, but their shipping remains the responsibility of the
Elven logs interceptor.

## Auto-discovered instrumentations

Instrumentation is activated only when the target module is installed and enabled.

Supported:

- HTTP, Express, Fastify, GraphQL
- PostgreSQL, MySQL2, MongoDB, Mongoose
- Redis (`redis` and `ioredis`), Knex, generic-pool
- NestJS, Koa
- DNS, Net (default off)
- Pino and Winston (correlation only)

## Privacy defaults

Default privacy policy:

- redact `db.statement` and `db.query.text`
- hash `user.id` and `enduser.id`
- allowlist raw attributes via `privacy.allowRawAttributes`

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run benchmark
```

`npm run benchmark:ci` enforces the p95 latency overhead budget (`< 3%`).
