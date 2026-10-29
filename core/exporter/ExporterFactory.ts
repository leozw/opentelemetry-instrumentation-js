/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ExporterFactory {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() { }

  public static createTraceExporter(config: ExporterConfig): SpanExporter {
    const protocol = config.protocol ?? (process.env.OTEL_EXPORTER_OTLP_PROTOCOL as Protocol) ?? 'http/protobuf';
    const compression = config.compression ?? (process.env.OTEL_EXPORTER_OTLP_COMPRESSION as Compression) ?? 'none';

    // Pass config.url if present. If not, don't pass anything and let Exporter read OTEL_EXPORTER_OTLP_ENDPOINT/TRACES_ENDPOINT with correct suffix logic.
    const exportConfig: any = {
      headers: config.headers,
      compression: compression,
    };
    const url = config.tracesUrl ?? (
      config.url && protocol === 'http/protobuf'
        ? appendSignalPath(config.url, 'v1/traces')
        : config.url
    );
    if (url) exportConfig.url = url;

    if (protocol === 'grpc') {
      return new OTLPGrpcTraceExporter(exportConfig);
    }
    return createBoundedHttpExporter(options => new OTLPHttpTraceExporter(options), exportConfig, 'TRACES');
  }

  public static createMetricExporter(config: ExporterConfig): PushMetricExporter {
    const protocol = config.protocol ?? (process.env.OTEL_EXPORTER_OTLP_PROTOCOL as Protocol) ?? 'http/protobuf';
    const compression = config.compression ?? (process.env.OTEL_EXPORTER_OTLP_COMPRESSION as Compression) ?? 'none';

    const exportConfig: any = {
      headers: config.headers,
      compression: compression,
    };
    const url = config.metricsUrl ?? (
      config.url && protocol === 'http/protobuf'
        ? appendSignalPath(config.url, 'v1/metrics')
        : config.url
    );
    if (url) exportConfig.url = url;

    if (protocol === 'grpc') {
      return new OTLPGrpcMetricExporter(exportConfig);
    }
    return createBoundedHttpExporter(options => new OTLPHttpMetricExporter(options), exportConfig, 'METRICS');
  }
}

import { OTLPMetricExporter as OTLPGrpcMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as OTLPHttpMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { boundedAgent } from './BoundedAgent';

function createBoundedHttpExporter<T extends SpanExporter | PushMetricExporter>(create: (options: any) => T, config: any, signal: 'TRACES' | 'METRICS'): T {
  const parsed = Number(process.env[`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`] ?? process.env.OTEL_EXPORTER_OTLP_TIMEOUT ?? 10_000);
  const timeoutMillis = Number.isFinite(parsed) && parsed > 0 ? Math.min(60_000, parsed) : 10_000;
  const agents = boundedAgent(timeoutMillis);
  const exporter = create({ ...config, timeoutMillis, httpAgentOptions: agents.factory });
  const shutdown = exporter.shutdown.bind(exporter);
  exporter.shutdown = async () => {
    try { await shutdown(); }
    finally { agents.destroy(); }
  };
  return exporter;
}

export type Protocol = 'grpc' | 'http/protobuf';
export type Compression = 'gzip' | 'none';

export interface ExporterConfig {
  protocol?: Protocol;
  /** Base OTLP URL. HTTP exporters append /v1/traces or /v1/metrics. */
  url?: string;
  /** Exact signal endpoint; takes precedence over url. */
  tracesUrl?: string;
  /** Exact signal endpoint; takes precedence over url. */
  metricsUrl?: string;
  headers?: Record<string, string>;
  compression?: Compression;
}

function appendSignalPath(baseUrl: string, signalPath: 'v1/traces' | 'v1/metrics'): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1\/(traces|metrics)$/, '');
  url.pathname = `${basePath}/${signalPath}`.replace(/\/+/g, '/');
  return url.toString();
}
