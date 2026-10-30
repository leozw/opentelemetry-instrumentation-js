import {
  createNoopMeter, metrics, MeterProvider as ApiMeterProvider, ProxyTracerProvider,
  TextMapPropagator, trace, TracerProvider as ApiTracerProvider,
} from '@opentelemetry/api';
import { getBooleanFromEnv } from '@opentelemetry/core';
import { Resource, ResourceDetector } from '@opentelemetry/resources';
import { MeterProvider, MetricReader, ViewOptions } from '@opentelemetry/sdk-metrics';
import { TracerProvider, Sampler, SpanProcessor } from '@opentelemetry/sdk-trace';
import { closeSmartSampler } from '../../core/sampler';
import { onceShutdown } from '../../core/memory/ConfigSnapshot';
import { registerProcessBootstrap } from './ProcessBootstrap';

export interface NodeRuntimeConfig {
  resource: Resource;
  /** Retained for internal compatibility; automatic detection remains disabled. */
  resourceDetectors?: ResourceDetector[];
  spanProcessors?: SpanProcessor[];
  metricReaders?: MetricReader[];
  sampler?: Sampler;
  textMapPropagator?: TextMapPropagator | null;
  views?: ViewOptions[];
}

const noopTracerProvider = new ProxyTracerProvider();
const noopMeter = createNoopMeter();
const noopMeterProvider: ApiMeterProvider = { getMeter: () => noopMeter };

export class NodeRuntime {
  private readonly resource: Resource;
  private readonly spanProcessors: SpanProcessor[];
  private readonly metricReaders: MetricReader[];
  private readonly sampler: Sampler | undefined;
  private readonly propagator: TextMapPropagator | null | undefined;
  private readonly views: ViewOptions[];
  private tracerProvider: TracerProvider | undefined;
  private meterProvider: MeterProvider | undefined;
  private ownedTraceGlobal: ApiTracerProvider | undefined;
  private started = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(config: NodeRuntimeConfig) {
    this.resource = config.resource;
    this.spanProcessors = (config.spanProcessors ?? []).map(onceShutdown);
    this.metricReaders = (config.metricReaders ?? []).map(onceShutdown);
    this.sampler = config.sampler;
    this.propagator = config.textMapPropagator;
    this.views = config.views ?? [];
  }

  public async start(): Promise<void> {
    if (this.started) return;
    if (this.shutdownPromise) throw new Error('ELVEN_RUNTIME_CLOSED');
    try {
      const sdkMetricsEnabled = getBooleanFromEnv('OTEL_NODE_EXPERIMENTAL_SDK_METRICS');
      if (this.metricReaders.length > 0) {
        const provider = this.meterProvider = onceShutdown(new MeterProvider({
          resource: this.resource, readers: this.metricReaders, views: this.views, sdkMetricsEnabled,
        }));
        if (!metrics.setGlobalMeterProvider(provider) || metrics.getMeterProvider() !== provider) this.registrationFailed();
      }
      if (this.spanProcessors.length > 0) {
        const provider = this.tracerProvider = onceShutdown(new TracerProvider({
          resource: this.resource,
          ...(this.sampler ? { sampler: this.sampler } : {}),
          spanProcessors: this.spanProcessors,
          ...(sdkMetricsEnabled && this.meterProvider ? { meterProvider: this.meterProvider } : {}),
          spanLimits: {
            attributeValueLengthLimit: 4096, attributeCountLimit: 128,
            eventCountLimit: 64, linkCountLimit: 64,
            attributePerEventCountLimit: 64, attributePerLinkCountLimit: 64,
          },
        }));
        let registered = false;
        try { registered = trace.setGlobalTracerProvider(provider); }
        finally {
          const current = trace.getTracerProvider();
          if (traceDelegate(current) === provider) this.ownedTraceGlobal = current;
        }
        if (!registered || !this.ownedTraceGlobal) this.registrationFailed();
      }
      // Bootstrap globals have process lifetime, not signal-provider lifetime.
      registerProcessBootstrap(this.propagator);
      this.started = true;
    } catch (error) {
      try { await this.shutdown(); } catch { /* Keep the original startup failure. */ }
      throw error;
    }
  }

  public getSignalProviders(): { tracerProvider: ApiTracerProvider; meterProvider: ApiMeterProvider } {
    return {
      tracerProvider: this.tracerProvider ?? noopTracerProvider,
      meterProvider: this.meterProvider ?? noopMeterProvider,
    };
  }

  public async forceFlush(): Promise<void> {
    await Promise.all([
      ...this.spanProcessors.map(processor => processor.forceFlush()),
      ...this.metricReaders
        .filter((reader): reader is MetricReader & { forceFlush: () => Promise<void> } => 'forceFlush' in reader)
        .map(reader => reader.forceFlush()),
    ]);
  }

  public shutdown(): Promise<void> {
    return this.shutdownPromise ??= this.stop();
  }

  private async stop(): Promise<void> {
    try {
      const results = await Promise.allSettled([
        ...(this.tracerProvider ? [this.tracerProvider.shutdown()] : []),
        ...(this.meterProvider ? [this.meterProvider.shutdown()] : []),
        ...this.spanProcessors.map(processor => processor.shutdown()),
        ...this.metricReaders.map(reader => reader.shutdown()),
      ]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } finally {
      closeSmartSampler(this.sampler);
      if (this.ownedTraceGlobal && trace.getTracerProvider() === this.ownedTraceGlobal
        && traceDelegate(this.ownedTraceGlobal) === this.tracerProvider) trace.disable();
      if (this.meterProvider && metrics.getMeterProvider() === this.meterProvider) metrics.disable();
      this.ownedTraceGlobal = undefined;
      this.tracerProvider = undefined;
      this.meterProvider = undefined;
      this.started = false;
    }
  }

  private registrationFailed(): never {
    throw new Error('Requested telemetry pipeline could not register its global provider');
  }

  public isStarted(): boolean { return this.started; }
}

function traceDelegate(provider: ApiTracerProvider): ApiTracerProvider {
  return provider instanceof ProxyTracerProvider ? provider.getDelegate() : provider;
}
