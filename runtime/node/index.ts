import { metrics, ProxyTracerProvider, Sampler, TextMapPropagator, trace, TracerProvider, MeterProvider } from '@opentelemetry/api';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { Resource } from '@opentelemetry/resources';
import { MetricReader, ViewOptions } from '@opentelemetry/sdk-metrics';
import { NodeSDK, NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface NodeRuntimeConfig {
  resource: Resource;
  resourceDetectors?: NodeSDKConfiguration['resourceDetectors'];
  spanProcessors?: SpanProcessor[];
  metricReaders?: MetricReader[];
  sampler?: Sampler;
  textMapPropagator?: TextMapPropagator | null;
  instrumentations?: Instrumentation[];
  views?: ViewOptions[];
}

export class NodeRuntime {
  private _sdk: NodeSDK;
  private _spanProcessors: SpanProcessor[];
  private _metricReaders: MetricReader[];
  private _started = false;
  private _ownedTracer: TracerProvider | undefined;
  private _ownedTraceDelegate: TracerProvider | undefined;
  private _ownedMeter: MeterProvider | undefined;

  constructor(config: NodeRuntimeConfig) {
    this._spanProcessors = config.spanProcessors ?? [];
    this._metricReaders = config.metricReaders ?? [];

    this._sdk = new NodeSDK({
      resource: config.resource,
      // This package correlates logs but does not own a log export pipeline.
      // An explicit empty list prevents NodeSDK from creating its default OTLP logger.
      logRecordProcessors: [],
      spanLimits: {
        attributeValueLengthLimit: 4096,
        attributeCountLimit: 128,
        eventCountLimit: 64,
        linkCountLimit: 64,
        attributePerEventCountLimit: 64,
        attributePerLinkCountLimit: 64,
      },
      resourceDetectors: config.resourceDetectors ?? [],
      autoDetectResources: false,
      // Spread optional properties to avoid passing undefined
      ...(config.spanProcessors ? { spanProcessors: config.spanProcessors } : {}),
      ...(config.sampler ? { sampler: config.sampler } : {}),
      ...(config.textMapPropagator ? { textMapPropagator: config.textMapPropagator } : {}),
      ...(config.instrumentations ? { instrumentations: config.instrumentations } : {}),
      ...(config.metricReaders ? { metricReaders: config.metricReaders } : {}),
      ...(config.views ? { views: config.views } : {}),
    });
  }

  public async start(): Promise<void> {
    if (this._started) return;
    const beforeTracer = trace.getTracerProvider();
    const beforeDelegate = traceDelegate(beforeTracer);
    const beforeMeter = metrics.getMeterProvider();
    this._sdk.start();
    const afterTracer = trace.getTracerProvider();
    const afterDelegate = traceDelegate(afterTracer);
    const afterMeter = metrics.getMeterProvider();
    if (afterDelegate !== beforeDelegate) {
      this._ownedTracer = afterTracer;
      this._ownedTraceDelegate = afterDelegate;
    }
    if (afterMeter !== beforeMeter) this._ownedMeter = afterMeter;
    // NodeSDK silently ignores failed global registration. A healthy handle
    // must not point at a foreign or previously closed signal pipeline.
    if ((this._spanProcessors.length > 0 && !this._ownedTracer)
      || (this._metricReaders.length > 0 && !this._ownedMeter)) {
      throw new Error('Requested telemetry pipeline could not register its global provider');
    }
    this._started = true;
  }

  public async forceFlush(): Promise<void> {
    await Promise.all([
      ...this._spanProcessors.map((processor) => processor.forceFlush()),
      ...this._metricReaders
        .filter((reader): reader is MetricReader & { forceFlush: () => Promise<void> } => 'forceFlush' in reader)
        .map((reader) => reader.forceFlush()),
    ]);
  }

  public async shutdown(): Promise<void> {
    try {
      await this._sdk.shutdown();
    } finally {
      // Only unregister this generation's still-current public API identities.
      // NodeSDK shuts its providers down but leaves their global registration.
      if (this._ownedTracer && trace.getTracerProvider() === this._ownedTracer
        && traceDelegate(this._ownedTracer) === this._ownedTraceDelegate) trace.disable();
      if (this._ownedMeter && metrics.getMeterProvider() === this._ownedMeter) metrics.disable();
      this._ownedTracer = undefined;
      this._ownedTraceDelegate = undefined;
      this._ownedMeter = undefined;
      this._started = false;
    }
  }

  public isStarted(): boolean {
    return this._started;
  }
}

function traceDelegate(provider: TracerProvider): TracerProvider {
  return provider instanceof ProxyTracerProvider ? provider.getDelegate() : provider;
}
