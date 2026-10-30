import type { ObservabilityConfig } from './types';
import { INSTRUMENTATION_NAMES } from '../instrumentations/config';
import { snapshotConfig } from '../core/memory/ConfigSnapshot';

export function observabilitySnapshot(source: ObservabilityConfig): ObservabilityConfig {
  const config = snapshotConfig(source);
  record(config); record(config.service);
  if (typeof config.service.serviceName !== 'string' || !config.service.serviceName.length) invalid();
  booleans(config, ['failOpen', 'autoShutdown']);
  if (config.runtime !== undefined && !['node', 'edge', 'serverless'].includes(config.runtime)) invalid();
  if (config.tracing !== undefined) {
    record(config.tracing); booleans(config.tracing, ['enabled']);
    if (config.tracing.sampling !== undefined) record(config.tracing.sampling);
  }
  if (config.metrics !== undefined) {
    record(config.metrics); booleans(config.metrics, ['enabled']);
    for (const key of ['exportIntervalMillis', 'exportTimeoutMillis'] as const) {
      const value = config.metrics[key];
      if (value !== undefined && (typeof value !== 'number' || value < 1 || value > 300_000)) invalid();
    }
    for (const key of ['cardinalityLimit', 'maxExportBatchSize'] as const) {
      const value = config.metrics[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'cardinalityLimit' ? 2 : 1) || value > 100_000)) invalid();
    }
  }
  if (config.exporters !== undefined) record(config.exporters);
  if (config.privacy !== undefined) {
    record(config.privacy); booleans(config.privacy, ['redactDbStatement', 'hashUserId']);
  }
  if (config.instrumentations !== undefined && typeof config.instrumentations !== 'boolean') {
    record(config.instrumentations);
    for (const name of INSTRUMENTATION_NAMES) {
      const toggle = config.instrumentations[name];
      if (toggle !== undefined) { record(toggle); booleans(toggle, ['enabled']); }
    }
  }
  return config;
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof RegExp) invalid();
}
function booleans(value: object, keys: string[]): void {
  for (const key of keys) {
    const member: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (member !== undefined && typeof member !== 'boolean') invalid();
  }
}
function invalid(): never { throw new Error('ELVEN_CONFIG_VALUE'); }
