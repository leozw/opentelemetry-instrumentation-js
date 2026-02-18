import { Sampler, TextMapPropagator } from '@opentelemetry/api';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { Resource } from '@opentelemetry/resources';
import { MetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SpanProcessor } from '@opentelemetry/sdk-trace-base';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Detector = any;

export interface NodeRuntimeConfig {
  resource: Resource;
  resourceDetectors?: Detector[];
  spanProcessors?: SpanProcessor[];
  metricReaders?: MetricReader[];
  sampler?: Sampler;
  textMapPropagator?: TextMapPropagator | null;
  instrumentations?: Instrumentation[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  views?: any[];
}

export class NodeRuntime {
  private _sdk: NodeSDK;

  constructor(config: NodeRuntimeConfig) {
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

  public start() {
    this._sdk.start();
  }

  public async shutdown() {
    await this._sdk.shutdown();
  }
}
