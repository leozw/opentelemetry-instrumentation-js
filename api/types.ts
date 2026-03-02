import { ExporterConfig } from '../core/exporter';
import { ResourceConfig } from '../core/resources';
import { SmartSamplerConfig } from '../core/sampler';
import { InstrumentationsConfig } from '../instrumentations/config';
import { MetricFacade } from '../core/metrics';
import { TracerFacade } from '../core/tracing';

export interface TracingConfig {
  enabled?: boolean;
  sampling?: SmartSamplerConfig;
}

export interface MetricsConfig {
  enabled?: boolean;
  exportIntervalMillis?: number;
}

export interface PrivacyConfig {
  redactDbStatement?: boolean;
  hashUserId?: boolean;
  allowRawAttributes?: string[];
}

export interface ObservabilityConfig {
  /**
   * Service identification and resource attributes.
   */
  service: ResourceConfig;

  /**
   * Exporter configuration.
   * Defaults to OTLP HTTP/protobuf.
   */
  exporters?: ExporterConfig;

  /**
   * Runtime environment.
   * v2 supports only node runtime.
   */
  runtime?: 'node' | 'serverless' | 'edge';

  /**
   * Tracing feature config.
   */
  tracing?: TracingConfig;

  /**
   * Metrics feature config.
   */
  metrics?: MetricsConfig;

  /**
   * Instrumentation toggles.
   */
  instrumentations?: InstrumentationsConfig;

  /**
   * Privacy defaults for attribute sanitization.
   */
  privacy?: PrivacyConfig;
}

export interface ObservabilityHandle {
  tracer: TracerFacade;
  metrics: MetricFacade;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
  isStarted(): boolean;
}
