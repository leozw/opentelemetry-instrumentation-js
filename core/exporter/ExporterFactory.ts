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
    return new OTLPHttpTraceExporter(exportConfig);
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
    return new OTLPHttpMetricExporter(exportConfig);
  }
}

import { OTLPMetricExporter as OTLPGrpcMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as OTLPHttpMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { SpanExporter } from '@opentelemetry/sdk-trace-base';

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
