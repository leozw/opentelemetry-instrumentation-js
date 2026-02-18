# OpenTelemetry Instrumentation JS

> **Production-Grade**: High-performance, resilient, zero-config observability for modern JavaScript applications.

[![License](https://img.shields.io/npm/l/opentelemetry-instrumentation-js)](https://github.com/leozw/opentelemetry-instrumentation-js)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue)](https://www.typescriptlang.org/)

This library provides a **battery-included** but strictly modular instrumentation for specialized environments (Node.js, Serverless, Edge). It adheres to strict Semantic Conventions and ensures production-grade resiliency.

## 🌟 Key Features

- **Universal Core**: Unified logic for Tracing, Metrics, and Log Correlation.
- **Zero-Code Mode**: Auto-instrumentation without touching your application code.
- **Smart Auto-Discovery**: Automatically detects installed modules (pg, mongodb, ioredis, etc.) and creates trace spans.
- **Env Toggles**: Enable/disable any instrumentation via `OTEL_INSTR_*` environment variables.
- **Strict Typing**: Built with `strict: true` and `noImplicitAny` for TypeScript safety.
- **Resilient**: Built-in Circuit Breakers and Fallback mechanisms for exporters.
- **Performance**: Uses `AsyncLocalStorage` for zero-overhead context propagation.
- **Vendor Neutral**: Fully OTLP compatible (gRPC/HTTP).

---

## 🚀 Installation

```bash
npm install opentelemetry-instrumentation-js
```

## 🛠 Usage

### 1. Zero-Code (Recommended)

Run your application with the preloader. This automatically detects your environment and sets up instrumentation.

**Environment Variables:**

```bash
export OTEL_SERVICE_NAME="my-payment-service"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
```

**Run:**

```bash
node --require opentelemetry-instrumentation-js/preload app.js
```

### 2. Manual Initialization

For more control, initialize the library at the very top of your entry file.

```typescript
import { initObservability } from 'opentelemetry-instrumentation-js';

await initObservability({
  service: {
    serviceName: 'my-payment-service',
    serviceVersion: '1.0.0',
    deploymentEnvironment: 'production',
  },
  exporters: {
    protocol: 'grpc', // or 'http/protobuf'
    url: 'http://localhost:4317',
    compression: 'gzip',
  },
  sampling: {
    ratio: 1.0,
    rules: [{ attributeKey: 'http.route', attributeValue: '/checkout', decision: 1 }],
  },
});
```

---

## 🧩 Architecture

The library is designed with a Clean Architecture approach:

- **`core/`**: Pure logic for Context, Resources, Sampling, and Attributes. No runtime dependencies.
- **`runtime/`**: Adapters for specific environments (Node, Lambda, Cloudflare Workers).
- **`instrumentations/`**: Auto-wiring for popular frameworks, databases, caches, and ORMs.
- **`api/`**: Public-facing Facades for Tracing and Metrics to simplify usage.

---

## 📦 Auto-Discovered Instrumentations

These instrumentations are automatically activated when the target module is detected in your project. **No configuration needed.**

| Category          | Module         | Env Toggle                | What it traces              |
| ----------------- | -------------- | ------------------------- | --------------------------- |
| **HTTP**          | `http`/`https` | _(always on)_             | HTTP request/response spans |
| **Framework**     | `express`      | _(always on)_             | Express middleware & routes |
| **Framework**     | `fastify`      | _(always on)_             | Fastify handlers            |
| **API**           | `graphql`      | _(always on)_             | GraphQL resolvers & queries |
| **Database**      | `pg`           | `OTEL_INSTR_PG`           | PostgreSQL queries          |
| **Database**      | `mysql2`       | `OTEL_INSTR_MYSQL`        | MySQL queries               |
| **Database**      | `mongodb`      | `OTEL_INSTR_MONGODB`      | MongoDB operations          |
| **ORM**           | `mongoose`     | `OTEL_INSTR_MONGOOSE`     | Mongoose operations         |
| **Cache**         | `ioredis`      | `OTEL_INSTR_REDIS`        | Redis commands (ioredis)    |
| **Cache**         | `redis`        | `OTEL_INSTR_REDIS`        | Redis commands (node-redis) |
| **Query Builder** | `knex`         | `OTEL_INSTR_KNEX`         | Knex queries                |
| **Pool**          | `generic-pool` | `OTEL_INSTR_GENERIC_POOL` | Connection pool lifecycle   |
| **Framework**     | `@nestjs/core` | `OTEL_INSTR_NESTJS`       | NestJS handlers             |
| **Framework**     | `koa`          | `OTEL_INSTR_KOA`          | Koa middleware              |
| **Network**       | `dns`          | `OTEL_INSTR_DNS`          | DNS lookups _(opt-in)_      |
| **Network**       | `net`          | `OTEL_INSTR_NET`          | TCP connections _(opt-in)_  |
| **Logging**       | `pino`         | `OTEL_INSTR_PINO`         | Pino log correlation        |
| **Logging**       | `winston`      | `OTEL_INSTR_WINSTON`      | Winston log correlation     |

### Disabling an instrumentation

```bash
export OTEL_INSTR_PG=false      # Disable PostgreSQL tracing
export OTEL_INSTR_REDIS=false   # Disable Redis tracing
```

### Enabling opt-in instrumentations

```bash
export OTEL_INSTR_DNS=true      # Enable DNS tracing (disabled by default)
export OTEL_INSTR_NET=true      # Enable TCP tracing (disabled by default)
```

---

## ⚙️ Configuration Reference

| Option                   | Type                        | Default           | Description                               |
| ------------------------ | --------------------------- | ----------------- | ----------------------------------------- |
| `service.serviceName`    | `string`                    | `unknown_service` | Name of your service.                     |
| `service.serviceVersion` | `string`                    | `unknown`         | Version of your service.                  |
| `exporters.protocol`     | `'grpc' \| 'http/protobuf'` | `'http/protobuf'` | OTLP transport protocol.                  |
| `exporters.compression`  | `'gzip' \| 'none'`          | `'none'`          | Compression for OTLP export.              |
| `sampling.ratio`         | `number`                    | `1.0`             | Probabilistic sampling ratio (0.0 - 1.0). |

---

## 🤝 Contributing

We enforce strict quality standards:

1. **No `any`**: All code must be strictly typed.
2. **Lint**: `npm run lint` must pass.
3. **Format**: Code must be formatted with Prettier.

### Build & Test

```bash
npm install
npm run build
npm run lint
```

---

## 📄 License

Apache-2.0
