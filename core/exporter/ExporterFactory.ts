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
    if (config.url) exportConfig.url = config.url;

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
    if (config.url) exportConfig.url = config.url;

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
  url?: string;
  headers?: Record<string, string>;
  compression?: Compression;
}
