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

// If this file is required, we assume the user wants instrumentation.
// We fallback to 'true' to ensure it runs even if env vars are missing/delayed.
const shouldInit = process.env.OTEL_ZERO_CODE === 'true' ||
  process.env.NODE_OPTIONS?.includes('--require') ||
  true;

if (shouldInit) {
  try {
    initObservability({
      service: {
        serviceName,
        serviceVersion: process.env.OTEL_SERVICE_VERSION || '0.0.0',
      },
      exporters: {}, // Will default to env vars
      runtime: 'node',
    });
  } catch (err) {
    console.warn('[instrumentation-js] Failed to initialize:', err);
  }
}
