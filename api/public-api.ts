import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { PeriodicExportingMetricReader, PushMetricExporter } from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  BatchSpanProcessor,
  BufferConfig as SpanBufferConfig,
  ConsoleSpanExporter,
  Sampler,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ExporterFactory, RedactingSpanExporter, ResolvedPrivacyConfig } from '../core/exporter';
import { MetricFacade } from '../core/metrics';
import { NetworkPropagator } from '../core/propagation';
import { ResourceBuilder } from '../core/resources';
import { createSmartSampler } from '../core/sampler';
import { TracerFacade } from '../core/tracing';
import { getCoreInstrumentations } from '../instrumentations';
import { NodeRuntime } from '../runtime/node';
import { ObservabilityConfig, ObservabilityHandle } from './types';

export let tracer: TracerFacade;
export let metrics: MetricFacade;

type LifecycleState = 'idle' | 'starting' | 'started' | 'stopping';

let lifecycleState: LifecycleState = 'idle';
let startupPromise: Promise<ObservabilityHandle> | null = null;
let shutdownPromise: Promise<void> | null = null;
let runtimeInstance: NodeRuntime | null = null;
let activeHandle: ObservabilityHandle | null = null;
let gracefulShutdownHookRegistered = false;
let unregisterInstrumentations: (() => void) | null = null;

export async function initObservability(config: ObservabilityConfig): Promise<ObservabilityHandle> {
  if (lifecycleState === 'starting' && startupPromise) {
    return startupPromise;
  }
  if (lifecycleState === 'started' && activeHandle) {
    return activeHandle;
  }
  if (lifecycleState === 'stopping' && shutdownPromise) {
    await shutdownPromise;
  }

  startupPromise = startObservability(config);
  return startupPromise;
}

async function startObservability(config: ObservabilityConfig): Promise<ObservabilityHandle> {
  lifecycleState = 'starting';

  try {
    const runtime = config.runtime ?? 'node';
    if (runtime !== 'node') {
      throw new Error(
        `[instrumentation-js] Runtime "${runtime}" is not supported in v2. Use runtime: "node".`
      );
    }

    const resolvedPrivacy = resolvePrivacyConfig(config);
    const tracingEnabled = resolveTracingEnabled(config);
    const metricsEnabled = resolveMetricsEnabled(config);
    const autoShutdownEnabled = config.autoShutdown
      ?? resolveBooleanEnv(process.env.OTEL_AUTO_SHUTDOWN)
      ?? true;

    if (!tracingEnabled && !metricsEnabled) {
      tracer = new TracerFacade(config.service.serviceName, config.service.serviceVersion);
      metrics = new MetricFacade(config.service.serviceName, config.service.serviceVersion);
      activeHandle = createHandle();
      lifecycleState = 'started';
      startupPromise = null;
      return activeHandle;
    }

    const resource = new ResourceBuilder(config.service).detect();
    const sampler = createSampler(config, tracingEnabled);
    const propagator = NetworkPropagator.create();

    const spanProcessors: SpanProcessor[] = [];
    const traceExporter = createTraceExporter(config, tracingEnabled, resolvedPrivacy);
    if (traceExporter) {
      spanProcessors.push(
        new BatchSpanProcessor(traceExporter, resolveSpanProcessorConfig())
      );
    }

    const metricReaders: PeriodicExportingMetricReader[] = [];
    const metricExporter = createMetricExporter(config, metricsEnabled);
    if (metricExporter) {
      const exportIntervalMillis = resolveMetricInterval(config);
      metricReaders.push(
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis,
          exportTimeoutMillis: resolveMetricTimeout(config, exportIntervalMillis),
          cardinalityLimits: {
            default: resolveMetricCardinalityLimit(config),
          },
          maxExportBatchSize: resolveMetricBatchSize(config),
        })
      );
    }

    const instrumentations = tracingEnabled || metricsEnabled
      ? getCoreInstrumentations({
        ...(config.instrumentations !== undefined
          ? { config: config.instrumentations }
          : {}),
        privacy: resolvedPrivacy,
      })
      : [];

    if (instrumentations.length > 0) {
      unregisterInstrumentations = registerInstrumentations({
        instrumentations,
      });
    }

    runtimeInstance = new NodeRuntime({
      resource,
      sampler,
      textMapPropagator: propagator,
      // We still register synchronously above for early requires, but we MUST pass them 
      // here as well so NodeSDK will call setMeterProvider() on them when it starts.
      instrumentations,
      metricReaders,
      spanProcessors,
      views: [
        {
          instrumentName: 'http.server.request.duration',
          name: 'http_server_request_duration_seconds',
          meterName: '@opentelemetry/instrumentation-http',
        },
        {
          instrumentName: 'http.client.request.duration',
          name: 'http_client_request_duration_seconds',
          meterName: '@opentelemetry/instrumentation-http',
        },
        {
          instrumentName: 'http.server.request.body.size',
          name: 'http_server_request_body_size_bytes',
          meterName: '@opentelemetry/instrumentation-http',
        },
        {
          instrumentName: 'http.server.response.body.size',
          name: 'http_server_response_body_size_bytes',
          meterName: '@opentelemetry/instrumentation-http',
        },
      ],
    });

    await runtimeInstance.start();

    tracer = new TracerFacade(config.service.serviceName, config.service.serviceVersion);
    metrics = new MetricFacade(config.service.serviceName, config.service.serviceVersion);

    activeHandle = createHandle();

    lifecycleState = 'started';
    startupPromise = null;

    if (autoShutdownEnabled && !gracefulShutdownHookRegistered) {
      registerGracefulShutdownHook();
    }

    return activeHandle;
  } catch (error) {
    unregisterInstrumentations?.();
    unregisterInstrumentations = null;
    startupPromise = null;
    runtimeInstance = null;
    activeHandle = null;
    lifecycleState = 'idle';
    throw error;
  }
}

async function shutdownObservability(): Promise<void> {
  if (lifecycleState === 'idle') return;
  if (lifecycleState === 'stopping' && shutdownPromise) {
    return shutdownPromise;
  }

  lifecycleState = 'stopping';

  shutdownPromise = (async () => {
    try {
      await forceFlushObservability();
      await runtimeInstance?.shutdown();
    } finally {
      unregisterInstrumentations?.();
      unregisterInstrumentations = null;
      runtimeInstance = null;
      activeHandle = null;
      startupPromise = null;
      shutdownPromise = null;
      lifecycleState = 'idle';
    }
  })();

  return shutdownPromise;
}

async function forceFlushObservability(): Promise<void> {
  if (!runtimeInstance || lifecycleState === 'idle') return;
  await runtimeInstance.forceFlush();
}

function createTraceExporter(
  config: ObservabilityConfig,
  tracingEnabled: boolean,
  privacy: ResolvedPrivacyConfig
): SpanExporter | undefined {
  if (!tracingEnabled) return undefined;

  const tracesExporterEnv = process.env.OTEL_TRACES_EXPORTER || 'otlp';
  let exporter: SpanExporter | undefined;

  if (tracesExporterEnv === 'console') {
    exporter = new ConsoleSpanExporter();
  } else if (tracesExporterEnv === 'none') {
    exporter = undefined;
  } else {
    exporter = ExporterFactory.createTraceExporter(config.exporters || {});
  }

  if (!exporter) return undefined;
  return new RedactingSpanExporter(exporter, privacy);
}

function createMetricExporter(config: ObservabilityConfig, metricsEnabled: boolean) {
  if (!metricsEnabled) return undefined;

  const metricExporterEnv = process.env.OTEL_METRICS_EXPORTER || 'otlp';
  if (metricExporterEnv === 'none') return undefined;

  return ExporterFactory.createMetricExporter(config.exporters || {}) as PushMetricExporter;
}

function createSampler(config: ObservabilityConfig, tracingEnabled: boolean): Sampler {
  if (!tracingEnabled) {
    return new AlwaysOffSampler();
  }
  return createSmartSampler(resolveSamplingConfig(config));
}

function createHandle(): ObservabilityHandle {
  return {
    tracer,
    metrics,
    shutdown: shutdownObservability,
    forceFlush: forceFlushObservability,
    isStarted: () => lifecycleState === 'started' && (
      runtimeInstance === null || runtimeInstance.isStarted()
    ),
  };
}

function resolveSpanProcessorConfig(): SpanBufferConfig {
  const maxQueueSize = resolvePositiveInt(process.env.OTEL_BSP_MAX_QUEUE_SIZE, 512, 1, 65_536);
  return {
    maxQueueSize,
    maxExportBatchSize: Math.min(
      maxQueueSize,
      resolvePositiveInt(process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 128, 1, 65_536)
    ),
    scheduledDelayMillis: resolvePositiveInt(
      process.env.OTEL_BSP_SCHEDULE_DELAY,
      5_000,
      1,
      300_000
    ),
    exportTimeoutMillis: resolvePositiveInt(
      process.env.OTEL_BSP_EXPORT_TIMEOUT,
      10_000,
      1,
      300_000
    ),
  };
}

function resolveSamplingConfig(config: ObservabilityConfig) {
  const configured = config.tracing?.sampling || {};
  if (typeof configured.ratio === 'number') {
    return configured;
  }

  const standardSampler = process.env.OTEL_TRACES_SAMPLER?.trim().toLowerCase();
  if (standardSampler === 'always_off' || standardSampler === 'parentbased_always_off') {
    return { ...configured, ratio: 0 };
  }
  if (standardSampler === 'always_on' || standardSampler === 'parentbased_always_on') {
    return { ...configured, ratio: 1 };
  }

  const rawRatio =
    process.env.OTEL_TRACES_SAMPLING_RATIO ||
    process.env.OTEL_SAMPLING_RATIO ||
    process.env.OTEL_TRACES_SAMPLER_ARG;
  const parsedRatio = rawRatio === undefined ? undefined : Number.parseFloat(rawRatio);
  if (parsedRatio !== undefined && Number.isFinite(parsedRatio)) {
    return { ...configured, ratio: Math.max(0, Math.min(1, parsedRatio)) };
  }

  return { ...configured, ratio: 0.1 };
}

function resolveMetricInterval(config: ObservabilityConfig): number {
  const fromConfig = config.metrics?.exportIntervalMillis;
  if (typeof fromConfig === 'number' && fromConfig > 0) return fromConfig;

  const envInterval = process.env.OTEL_METRIC_EXPORT_INTERVAL;
  if (!envInterval) return 60000;

  const parsed = parseInt(envInterval, 10);
  if (isNaN(parsed) || parsed <= 0) return 60000;
  return parsed;
}

function resolveMetricTimeout(config: ObservabilityConfig, intervalMillis: number): number {
  const configured = config.metrics?.exportTimeoutMillis;
  const timeout = configured && configured > 0
    ? configured
    : resolvePositiveInt(process.env.OTEL_METRIC_EXPORT_TIMEOUT, 10_000, 1, 300_000);
  return Math.min(timeout, Math.max(1, intervalMillis - 1));
}

function resolveMetricCardinalityLimit(config: ObservabilityConfig): number {
  const configured = config.metrics?.cardinalityLimit;
  if (configured && configured > 1) return Math.floor(configured);
  return resolvePositiveInt(
    process.env.OTEL_METRICS_CARDINALITY_LIMIT || process.env.OTEL_METRIC_CARDINALITY_LIMIT,
    500,
    2,
    100_000
  );
}

function resolveMetricBatchSize(config: ObservabilityConfig): number {
  const configured = config.metrics?.maxExportBatchSize;
  if (configured && configured > 0) return Math.floor(configured);
  return resolvePositiveInt(process.env.OTEL_METRIC_EXPORT_BATCH_SIZE, 512, 1, 100_000);
}

function resolvePositiveInt(
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (rawValue === undefined) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

function resolveTracingEnabled(config: ObservabilityConfig): boolean {
  const explicit = config.tracing?.enabled;
  if (explicit !== undefined) return explicit;

  const fromEnv = resolveBooleanEnv(process.env.OTEL_TRACING_ENABLED);
  if (fromEnv !== undefined) return fromEnv;

  return process.env.OTEL_TRACES_EXPORTER !== 'none';
}

function resolveMetricsEnabled(config: ObservabilityConfig): boolean {
  const explicit = config.metrics?.enabled;
  if (explicit !== undefined) return explicit;

  const fromEnv = resolveBooleanEnv(process.env.OTEL_METRICS_ENABLED);
  if (fromEnv !== undefined) return fromEnv;

  return process.env.OTEL_METRICS_EXPORTER !== 'none';
}

function resolvePrivacyConfig(config: ObservabilityConfig): ResolvedPrivacyConfig {
  const envRedact = resolveBooleanEnv(
    process.env.OTEL_PRIVACY_REDACT_DB_STATEMENT ||
    process.env.OTEL_INSTRUMENTATION_DB_STATEMENT_REDACTION
  );

  return {
    redactDbStatement: envRedact ?? config.privacy?.redactDbStatement ?? true,
    hashUserId: config.privacy?.hashUserId ?? true,
    allowRawAttributes: config.privacy?.allowRawAttributes ?? [],
  };
}

function resolveBooleanEnv(rawValue: string | undefined): boolean | undefined {
  if (rawValue === undefined) return undefined;
  const value = rawValue.trim().toLowerCase();
  if (value === '' || value === 'auto') return undefined;
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  return undefined;
}

function registerGracefulShutdownHook(): void {
  gracefulShutdownHookRegistered = true;

  const shutdownAndExit = async (signal: string) => {
    try {
      await shutdownObservability();
    } catch (err) {
      console.warn(`[instrumentation-js] graceful shutdown failed on ${signal}:`, err);
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => {
    void shutdownAndExit('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdownAndExit('SIGTERM');
  });
}

export { MetricFacade } from '../core/metrics';
export { TracerFacade } from '../core/tracing';
