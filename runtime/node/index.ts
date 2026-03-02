import { Sampler, TextMapPropagator } from '@opentelemetry/api';
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

  constructor(config: NodeRuntimeConfig) {
    this._spanProcessors = config.spanProcessors ?? [];
    this._metricReaders = config.metricReaders ?? [];

    this._sdk = new NodeSDK({
      resource: config.resource,
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
    await Promise.resolve(this._sdk.start());
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
    if (!this._started) return;
    await this._sdk.shutdown();
    this._started = false;
  }

  public isStarted(): boolean {
    return this._started;
  }
}
