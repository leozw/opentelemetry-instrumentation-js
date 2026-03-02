import { initObservability } from './api/index';

// Try to load .env if available
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config();
} catch {
  // ignore
}

const serviceName = process.env.OTEL_SERVICE_NAME || 'unknown-service';

// Force HTTP semantic conventions to be consistent (Stable)
// This ensures metrics are emitted in SECONDS, not milliseconds.
if (!process.env.OTEL_SEMCONV_STABILITY_OPT_IN) {
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'http';
}

const shouldInit = process.env.OTEL_ZERO_CODE !== 'false';

if (shouldInit) {
  void initObservability({
    service: {
      serviceName,
      serviceVersion: process.env.OTEL_SERVICE_VERSION || '0.0.0',
    },
    runtime: 'node',
  }).catch((err) => {
    console.warn('[instrumentation-js] Failed to initialize:', err);
  });
}
