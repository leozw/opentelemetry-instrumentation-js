/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ExporterFactory {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() { }

  public static createTraceExporter(config: ExporterConfig): SpanExporter {
    config = ownedExporterConfig(config);
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
    config = ownedExporterConfig(config);
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
import { DataBudget, ownedString } from '../memory/OwnedData';
import { snapshotConfig } from '../memory/ConfigSnapshot';

function createBoundedHttpExporter<T extends SpanExporter | PushMetricExporter>(create: (options: any) => T, config: any, signal: 'TRACES' | 'METRICS'): T {
  const parsed = Number(process.env[`OTEL_EXPORTER_OTLP_${signal}_TIMEOUT`] ?? process.env.OTEL_EXPORTER_OTLP_TIMEOUT ?? 10_000);
  const timeoutMillis = Number.isFinite(parsed) && parsed > 0 ? Math.min(60_000, parsed) : 10_000;
  const agents = boundedAgent(timeoutMillis);
  let exporter: T;
  try { exporter = create({ ...config, timeoutMillis, httpAgentOptions: agents.factory }); }
  catch (error) { agents.destroy(); throw error; }
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

function ownedExporterConfig(config: ExporterConfig): ExporterConfig {
  config = snapshotConfig(config);
  if (config.headers !== undefined && (!config.headers || typeof config.headers !== 'object'
    || Array.isArray(config.headers) || config.headers instanceof RegExp)) throw new Error('ELVEN_EXPORTER_CONFIG_BUDGET');
  if ((config.protocol !== undefined && !['grpc', 'http/protobuf'].includes(config.protocol))
    || (config.compression !== undefined && !['gzip', 'none'].includes(config.compression))) throw new Error('ELVEN_EXPORTER_CONFIG_BUDGET');
  const headers: Record<string, string> = Object.create(null);
  const budget = new DataBudget();
  let count = 0;
  for (const key in config.headers) {
    if (++count > 64) throw new Error('ELVEN_EXPORTER_CONFIG_BUDGET');
    const descriptor = Object.getOwnPropertyDescriptor(config.headers, key);
    if (!descriptor) continue;
    if (!('value' in descriptor) || typeof descriptor.value !== 'string') throw new Error('ELVEN_EXPORTER_CONFIG_BUDGET');
    headers[budget.text(key)] = budget.text(descriptor.value);
  }
  return {
    ...(config.protocol !== undefined ? { protocol: config.protocol === 'grpc' ? 'grpc' : 'http/protobuf' } : {}),
    ...(config.compression !== undefined ? { compression: config.compression === 'gzip' ? 'gzip' : 'none' } : {}),
    ...(config.url !== undefined ? { url: ownedString(config.url, 16384) } : {}),
    ...(config.tracesUrl !== undefined ? { tracesUrl: ownedString(config.tracesUrl, 16384) } : {}),
    ...(config.metricsUrl !== undefined ? { metricsUrl: ownedString(config.metricsUrl, 16384) } : {}),
    headers,
  };
}

function appendSignalPath(baseUrl: string, signalPath: 'v1/traces' | 'v1/metrics'): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/v1\/(traces|metrics)$/, '');
  url.pathname = `${basePath}/${signalPath}`.replace(/\/+/g, '/');
  return url.toString();
}
