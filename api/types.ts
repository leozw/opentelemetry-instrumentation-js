import { ExporterConfig } from '../core/exporter';
import { ResourceConfig } from '../core/resources';
import { SmartSamplerConfig } from '../core/sampler';

export interface ObservabilityConfig {
  /**
   * Service identification and resource attributes.
   */
  service: ResourceConfig;

  /**
   * Exporter configuration.
   * Defaults to OTLP gRPC at localhost:4317.
   */
  exporters?: ExporterConfig;

  /**
   * Sampling configuration.
   */
  sampling?: SmartSamplerConfig;

  /**
   * Runtime environment.
   * Defaults to 'node'.
   */
  runtime?: 'node' | 'serverless' | 'edge';

  /**
   * Instrumentations configuration.
   * Pass explicit list or boolean to enable/disable defaults.
   */
  instrumentations?: {
    http?: boolean;
    express?: boolean;
    fastify?: boolean;
    graphql?: boolean;
    pg?: boolean;
    mysql?: boolean;
    mongodb?: boolean;
    mongoose?: boolean;
    redis?: boolean;
    knex?: boolean;
    genericPool?: boolean;
    nestjs?: boolean;
    koa?: boolean;
    dns?: boolean;
    net?: boolean;
    pino?: boolean;
    winston?: boolean;
  } | boolean;

  /**
   * Enable/Disable metrics.
   * Default: true
   */
  metrics?: boolean;

  /**
   * Enable/Disable tracing.
   * Default: true
   */
  tracing?: boolean;
}
