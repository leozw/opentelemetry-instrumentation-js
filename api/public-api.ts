import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExporterFactory } from '../core/exporter';
import { MetricFacade } from '../core/metrics';
import { NetworkPropagator } from '../core/propagation';
import { ResourceBuilder } from '../core/resources';
import { createSmartSampler } from '../core/sampler';
import { TracerFacade } from '../core/tracing';
import { getCoreInstrumentations } from '../instrumentations';
import { NodeRuntime } from '../runtime/node';
import { ObservabilityConfig } from './types';

// Global singletons for easy access
export let tracer: TracerFacade;
export let metrics: MetricFacade;

/**
 * Initialize Universal Observability.
 * This should be called as early as possible in your application.
 */
export async function initObservability(config: ObservabilityConfig) {
  // 1. Resource Detection (Sync)
  const resourceBuilder = new ResourceBuilder(config.service);
  let detectedResource = resourceBuilder.detect();

  // Create a clean resource directly
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allAttributes = (detectedResource as any)._attributes || (detectedResource as any).attributes || {};

  // Merge cleanly if strictly needed, but ResourceBuilder now produces clean data.
  // We just ensure we use what we detected.
  detectedResource = resourceFromAttributes(allAttributes);

  // 2. Exporters
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let traceExporter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let metricExporter: any;

  const tracesExporterEnv = process.env.OTEL_TRACES_EXPORTER || 'otlp';

  if (tracesExporterEnv === 'console') {
    traceExporter = new ConsoleSpanExporter();
  } else if (tracesExporterEnv === 'none') {
    // do nothing
  } else {
    // Default to OTLP
    traceExporter = ExporterFactory.createTraceExporter(config.exporters || {});
  }

  // Metrics Exporter (Default to OTLP for now, unless 'none')
  if (process.env.OTEL_METRICS_EXPORTER !== 'none') {
    metricExporter = ExporterFactory.createMetricExporter(config.exporters || {});
  }

  const spanProcessors = [];
  if (traceExporter) {
    spanProcessors.push(new BatchSpanProcessor(traceExporter));
  }

  // 3. Sampler
  const sampler = createSmartSampler(config.sampling || {});

  // 4. Propagator
  const propagator = NetworkPropagator.create();

  // 5. Instrumentations
  const instrumentations = getCoreInstrumentations();

  // 6. Runtime selection and start
  if (config.runtime === 'node' || !config.runtime) {
    const interval = process.env.OTEL_METRIC_EXPORT_INTERVAL
      ? parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL, 10)
      : 60000;

    console.log('[instrumentation-js] Metric Reader Interval:', interval);
    console.log('[instrumentation-js] Metric Exporter:', metricExporter ? 'Enabled' : 'Disabled');
    if (metricExporter) {
      console.log('[instrumentation-js] Metric Exporter Type:', metricExporter.constructor.name);
    }

    const metricReader = metricExporter ? new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: interval,
    }) : undefined;

    const runtime = new NodeRuntime({
      resource: detectedResource,
      sampler,
      textMapPropagator: propagator,
      instrumentations,
      metricReaders: metricReader ? [metricReader] : [],
      spanProcessors: spanProcessors,
      views: [
        // Stable: http.server.request.duration -> seconds
        {
          instrumentName: 'http.server.request.duration',
          name: 'http_server_request_duration_seconds',
          meterName: '@opentelemetry/instrumentation-http',
        },
        // Stable: http.client.request.duration -> seconds
        {
          instrumentName: 'http.client.request.duration',
          name: 'http_client_request_duration_seconds',
          meterName: '@opentelemetry/instrumentation-http',
        },
        // Request Body Size
        {
          instrumentName: 'http.server.request.body.size',
          name: 'http_server_request_body_size_bytes',
          meterName: '@opentelemetry/instrumentation-http',
        },
        // Response Body Size
        {
          instrumentName: 'http.server.response.body.size',
          name: 'http_server_response_body_size_bytes',
          meterName: '@opentelemetry/instrumentation-http',
        }
      ],
    });

    runtime.start();
  }

  // Initialize Facades
  tracer = new TracerFacade(config.service.serviceName, config.service.serviceVersion);
  metrics = new MetricFacade(config.service.serviceName, config.service.serviceVersion);

  // Return runtime instance or control handle
  return {
    tracer,
    metrics,
  };
}

// Export Facade Types
export { MetricFacade } from '../core/metrics';
export { TracerFacade } from '../core/tracing';

