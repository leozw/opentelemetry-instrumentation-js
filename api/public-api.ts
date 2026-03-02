import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  Sampler,
  SpanProcessor,
  SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { PushMetricExporter } from '@opentelemetry/sdk-metrics';
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
    const autoShutdownEnabled = resolveBooleanEnv(process.env.OTEL_AUTO_SHUTDOWN) ?? true;

    const resource = new ResourceBuilder(config.service).detect();
    const sampler = createSampler(config, tracingEnabled);
    const propagator = NetworkPropagator.create();

    const spanProcessors: SpanProcessor[] = [];
    const traceExporter = createTraceExporter(config, tracingEnabled, resolvedPrivacy);
    if (traceExporter) {
      spanProcessors.push(new BatchSpanProcessor(traceExporter));
    }

    const metricReaders: PeriodicExportingMetricReader[] = [];
    const metricExporter = createMetricExporter(config, metricsEnabled);
    if (metricExporter) {
      metricReaders.push(
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: resolveMetricInterval(config),
        })
      );
    }

    const instrumentations = tracingEnabled || metricsEnabled
      ? getCoreInstrumentations({
        ...(config.instrumentations ? { config: config.instrumentations } : {}),
        privacy: resolvedPrivacy,
      })
      : [];

    runtimeInstance = new NodeRuntime({
      resource,
      sampler,
      textMapPropagator: propagator,
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

    activeHandle = {
      tracer,
      metrics,
      shutdown: shutdownObservability,
      forceFlush: forceFlushObservability,
      isStarted: () => lifecycleState === 'started' && runtimeInstance?.isStarted() === true,
    };

    lifecycleState = 'started';
    startupPromise = null;

    if (autoShutdownEnabled && !gracefulShutdownHookRegistered) {
      registerGracefulShutdownHook();
    }

    return activeHandle;
  } catch (error) {
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
  if (!runtimeInstance || lifecycleState !== 'started') return;
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
  return createSmartSampler(config.tracing?.sampling || {});
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
  return {
    redactDbStatement: config.privacy?.redactDbStatement ?? true,
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
