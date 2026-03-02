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
  service: {
    serviceName: 'my-payment-service',
    serviceVersion: '1.0.0',
    deploymentEnvironment: 'production',
  },
  exporters: {
    protocol: 'grpc', // or 'http/protobuf'
    compression: 'gzip',
  },
  tracing: {
    enabled: true,
    sampling: {
      ratio: 1.0,
    },
  },
  metrics: {
    enabled: true,
    exportIntervalMillis: 60000,
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
