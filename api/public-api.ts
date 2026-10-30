import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { createNoopMeter, ProxyTracerProvider } from '@opentelemetry/api';
import { getBooleanFromEnv } from '@opentelemetry/core';
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
import { ResourceBuilder } from '../core/resources';
import { closeSmartSampler, createSmartSampler } from '../core/sampler';
import { TracerFacade } from '../core/tracing';
import { SpanPayloadLimitProcessor } from '../core/tracing/SpanPayloadLimitProcessor';
import { getCoreInstrumentations } from '../instrumentations';
import { NodeRuntime } from '../runtime/node';
import { ObservabilityConfig, ObservabilityHandle } from './types';
import { ownedString } from '../core/memory/OwnedData';
import { onceShutdown, ownBoolean } from '../core/memory/ConfigSnapshot';
import { observabilitySnapshot } from './config';

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
let removeShutdownHooks: (() => void) | null = null;

const registryKey = Symbol.for('elven.observability.node.lifecycle.v1');
const registry = globalThis as typeof globalThis & {
  [registryKey]?: { pending?: Promise<ObservabilityHandle>; handle?: ObservabilityHandle; disabled?: ObservabilityHandle };
};
const sharedLifecycle = registry[registryKey] ??= {};

export async function initObservability(config: ObservabilityConfig): Promise<ObservabilityHandle> {
  // Disable applies before config admission, including a hot call. It does not
  // take ownership of an existing generation: that owner's shutdown stays explicit.
  if (getBooleanFromEnv('OTEL_SDK_DISABLED')) {
    const handle = sharedLifecycle.disabled?.isStarted()
      ? sharedLifecycle.disabled : sharedLifecycle.disabled = createNoopHandle(true);
    tracer = handle.tracer; metrics = handle.metrics;
    return handle;
  }
  if (sharedLifecycle.handle?.isStarted()) {
    tracer = sharedLifecycle.handle.tracer;
    metrics = sharedLifecycle.handle.metrics;
    return sharedLifecycle.handle;
  }
  const failOpen = ownBoolean(config, 'failOpen');
  let pending: Promise<ObservabilityHandle> | undefined;
  try {
    if (!sharedLifecycle.pending) sharedLifecycle.pending = initLocal(observabilitySnapshot(config));
    pending = sharedLifecycle.pending;
    const handle = await pending;
    sharedLifecycle.handle = handle;
    tracer = handle.tracer;
    metrics = handle.metrics;
    return handle;
  } catch (error) {
    if (!failOpen) throw error;
    const handle = createNoopHandle(false);
    tracer = handle.tracer; metrics = handle.metrics;
    return handle;
  } finally {
    if (pending && sharedLifecycle.pending === pending) delete sharedLifecycle.pending;
  }
}

function createNoopHandle(started: boolean): ObservabilityHandle {
  let active = started;
  const name = started ? 'elven-observability-disabled' : 'elven-observability-noop';
  const handle: ObservabilityHandle = {
    tracer: new TracerFacade(name, undefined, new ProxyTracerProvider().getTracer(name)),
    metrics: new MetricFacade(name, undefined, createNoopMeter()),
    isStarted: () => active,
    forceFlush: () => Promise.resolve(),
    shutdown: async () => {
      active = false;
      if (sharedLifecycle.disabled === handle) delete sharedLifecycle.disabled;
    },
  };
  return handle;
}

async function initLocal(config: ObservabilityConfig): Promise<ObservabilityHandle> {
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
  let sampler: Sampler | undefined;
  const owned: { shutdown(): Promise<void> }[] = [];
  const own = <T extends { shutdown(): Promise<void> }>(component: T): T => {
    onceShutdown(component); owned.push(component); return component;
  };

  try {
    const serviceName = ownedString(config.service.serviceName, 255);
    const serviceVersion = ownedString(config.service.serviceVersion, 255);
    const runtime = config.runtime ?? 'node';
    if (runtime !== 'node') {
      throw new Error(
        `[instrumentation-js] Runtime "${runtime}" is not supported in v2. Use runtime: "node".`
      );
    }

    const sdkDisabled = getBooleanFromEnv('OTEL_SDK_DISABLED');
    const tracingEnabled = !sdkDisabled && resolveTracingEnabled(config);
    const metricsEnabled = !sdkDisabled && resolveMetricsEnabled(config);

    if (!tracingEnabled && !metricsEnabled) {
      // Intentional global disable is successful no-op initialization, not a
      // registration failure. Do not borrow another owner's active providers.
      tracer = new TracerFacade(serviceName, serviceVersion, new ProxyTracerProvider().getTracer(serviceName));
      metrics = new MetricFacade(serviceName, serviceVersion, createNoopMeter());
      activeHandle = createHandle();
      lifecycleState = 'started';
      startupPromise = null;
      return activeHandle;
    }

    const resolvedPrivacy = resolvePrivacyConfig(config);
    const autoShutdownEnabled = config.autoShutdown
      ?? resolveBooleanEnv(process.env.OTEL_AUTO_SHUTDOWN)
      ?? true;
    const resource = new ResourceBuilder(config.service, resolvedPrivacy).detect();
    sampler = createSampler(config, tracingEnabled);

    const spanProcessors: SpanProcessor[] = [];
    const traceExporter = createTraceExporter(config, tracingEnabled, resolvedPrivacy);
    if (traceExporter) {
      own(traceExporter);
      spanProcessors.push(own(
        new SpanPayloadLimitProcessor(new BatchSpanProcessor(traceExporter, resolveSpanProcessorConfig()))
      ));
    }

    const metricReaders: PeriodicExportingMetricReader[] = [];
    const metricExporter = createMetricExporter(config, metricsEnabled);
    if (metricExporter) {
      own(metricExporter);
      const exportIntervalMillis = resolveMetricInterval(config);
      metricReaders.push(
        own(new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis,
          exportTimeoutMillis: resolveMetricTimeout(config, exportIntervalMillis),
          cardinalityLimits: {
            default: resolveMetricCardinalityLimit(config),
          },
          maxExportBatchSize: resolveMetricBatchSize(config),
        }))
      );
    }

    runtimeInstance = new NodeRuntime({
      resource,
      sampler,
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

    const providers = runtimeInstance.getSignalProviders();
    const instrumentations = getCoreInstrumentations({
      ...(config.instrumentations !== undefined ? { config: config.instrumentations } : {}),
      privacy: resolvedPrivacy,
      meterProvider: providers.meterProvider,
    });
    if (instrumentations.length > 0) {
      try { unregisterInstrumentations = registerInstrumentations({ instrumentations, ...providers }); }
      catch (error) {
        // Upstream can throw after enabling only part of this owned list.
        for (const instrumentation of instrumentations) {
          try { instrumentation.disable(); } catch { /* Preserve the registration error. */ }
        }
        throw error;
      }
    }
    tracer = new TracerFacade(serviceName, serviceVersion, providers.tracerProvider.getTracer(serviceName, serviceVersion));
    metrics = new MetricFacade(serviceName, serviceVersion, providers.meterProvider.getMeter(serviceName, serviceVersion), resolvedPrivacy);

    activeHandle = createHandle();

    lifecycleState = 'started';
    startupPromise = null;

    if (autoShutdownEnabled && !gracefulShutdownHookRegistered) {
      registerGracefulShutdownHook();
    }

    return activeHandle;
  } catch (error) {
    try { await runtimeInstance?.shutdown(); } catch { /* Preserve the original startup failure. */ }
    // Components can exist before the runtime builds its providers. Their guarded
    // shutdown also makes retrying cleanup after a partial SDK failure idempotent.
    await Promise.allSettled(owned.map(component => component.shutdown()));
    closeSmartSampler(sampler);
    try { unregisterInstrumentations?.(); } catch { /* Preserve the startup error. */ }
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
      // Provider shutdown flushes processors itself; a preceding failed forceFlush
      // must not skip cleanup or double the exporter retry budget.
      await runtimeInstance?.shutdown();
    } finally {
      removeShutdownHooks?.();
      removeShutdownHooks = null;
      gracefulShutdownHookRegistered = false;
      try { unregisterInstrumentations?.(); } catch { /* Other owners must still be reset. */ }
      unregisterInstrumentations = null;
      runtimeInstance = null;
      activeHandle = null;
      delete sharedLifecycle.handle;
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
  const handle: ObservabilityHandle = {
    tracer,
    metrics,
    shutdown: () => activeHandle === handle ? shutdownObservability() : Promise.resolve(),
    forceFlush: () => activeHandle === handle ? forceFlushObservability() : Promise.resolve(),
    isStarted: () => activeHandle === handle && lifecycleState === 'started' && (
      runtimeInstance === null || runtimeInstance.isStarted()
    ),
  };
  return handle;
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
  if (fromConfig !== undefined) return fromConfig;
  return resolvePositiveInt(process.env.OTEL_METRIC_EXPORT_INTERVAL, 60_000, 1, 300_000);
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

  const allowRaw = config.privacy?.allowRawAttributes ?? [];
  if (!Array.isArray(allowRaw) || allowRaw.length > 128) throw new Error('ELVEN_PRIVACY_CONFIG_BUDGET');
  return {
    redactDbStatement: envRedact ?? config.privacy?.redactDbStatement ?? true,
    hashUserId: config.privacy?.hashUserId ?? true,
    allowRawAttributes: allowRaw.map(key => ownedString(key, 255)),
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
  const recentlyRemovedOwners = new Set<'SIGINT' | 'SIGTERM'>();
  const recordRemoval = (event: string | symbol, listener: unknown) => {
    if ((event !== 'SIGINT' && event !== 'SIGTERM') || listener === onInt || listener === onTerm || recentlyRemovedOwners.has(event)) return;
    // EventEmitter removes an application once-handler before invoking it.
    // Remember that ownership for this emission, without retaining its function.
    recentlyRemovedOwners.add(event);
    queueMicrotask(() => recentlyRemovedOwners.delete(event));
  };
  const cleanup = () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    process.off('removeListener', recordRemoval);
  };

  const shutdownAndExit = async (signal: 'SIGINT' | 'SIGTERM') => {
    const applicationOwnsSignal = recentlyRemovedOwners.has(signal)
      || process.listeners(signal).some(listener => listener !== onInt && listener !== onTerm);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        shutdownObservability(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Telemetry shutdown deadline exceeded')), 10_000);
        }),
      ]);
    } catch (err) {
      void err;
      console.warn('ELVEN_SHUTDOWN_FAILED');
    } finally {
      if (timeout) clearTimeout(timeout);
      cleanup();
      // Leave application-owned signal handlers in charge. Without one, restore
      // the platform's normal signal termination (including its exit status).
      if (!applicationOwnsSignal && process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    }
  };

  const onInt = () => { void shutdownAndExit('SIGINT'); };
  const onTerm = () => { void shutdownAndExit('SIGTERM'); };
  process.on('removeListener', recordRemoval);
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  removeShutdownHooks = cleanup;
}

export { MetricFacade } from '../core/metrics';
export { TracerFacade } from '../core/tracing';
