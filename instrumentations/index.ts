import { Attributes, Histogram, Meter, metrics } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Instrumentation } from '@opentelemetry/instrumentation';
import type { ServerResponse } from 'http';
import { ResolvedPrivacyConfig } from '../core/exporter';
import { INSTRUMENTATION_NAMES, InstrumentationsConfig } from './config';
import { getAutoInstrumentationsConfig } from './registry';

export interface BuildInstrumentationsOptions {
  config?: InstrumentationsConfig | boolean;
  privacy: ResolvedPrivacyConfig;
}

export function getCoreInstrumentations(options: BuildInstrumentationsOptions): Instrumentation[] {
  if (options.config === false) {
    return [];
  }

  let meter: Meter | undefined;
  let requestSizeHistogram: Histogram | undefined;
  let responseSizeHistogram: Histogram | undefined;

  const getHistograms = () => {
    if (!meter) {
      meter = metrics.getMeter('@opentelemetry/instrumentation-http');
      requestSizeHistogram = meter.createHistogram('http.server.request.body.size', {
        description: 'Size of the HTTP request body.',
        unit: 'By',
      });
      responseSizeHistogram = meter.createHistogram('http.server.response.body.size', {
        description: 'Size of the HTTP response body.',
        unit: 'By',
      });
    }
  };

  const autoConfig = getAutoInstrumentationsConfig({
    ...(typeof options.config === 'object' ? { config: options.config } : {}),
    privacy: options.privacy,
  });

  // Apply our custom HTTP hooks on top of whatever config was resolved
  const httpConfig = (autoConfig['@opentelemetry/instrumentation-http'] as Record<string, unknown>) || {};
  if (httpConfig.enabled !== false) {
    autoConfig['@opentelemetry/instrumentation-http'] = {
      ...httpConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyCustomAttributesOnSpan: (_span: any, request: any, response: any) => {
        if (!request || typeof request !== 'object' || !('headers' in request)) return;
        const castResponse = response as ServerResponse;
        const reqSize = Number.parseInt(String(request.headers['content-length']), 10);
        const respSize = Number.parseInt(String(castResponse.getHeader('content-length')), 10);
        if (!Number.isFinite(reqSize) && !Number.isFinite(respSize)) return;
        getHistograms();
        const attributes: Attributes = {};
        if (request.method) attributes['http.request.method'] = request.method;
        if (castResponse.statusCode) attributes['http.response.status_code'] = castResponse.statusCode;

        if (Number.isFinite(respSize)) responseSizeHistogram?.record(respSize, attributes);
        if (Number.isFinite(reqSize)) requestSizeHistogram?.record(reqSize, attributes);
      },
    };
  }

  const key = Symbol.for('elven.observability.node.instrumentations.v1');
  const registry = globalThis as typeof globalThis & { [key]?: Instrumentation[] };
  if (!registry[key]) {
    // Reuse public instrumentation instances: upstream caches require hooks and
    // a fresh instance cannot repatch already-cached core modules after restart.
    const creationConfig = getAutoInstrumentationsConfig({
      config: Object.fromEntries(INSTRUMENTATION_NAMES.map(name => [name, { enabled: true }])),
      privacy: options.privacy,
    });
    registry[key] = getNodeAutoInstrumentations(creationConfig).filter(instrumentation => {
      const included = Object.hasOwn(creationConfig, instrumentation.instrumentationName)
        && instrumentation.getConfig().enabled !== false;
      if (!included) instrumentation.disable();
      return included;
    });
  }
  return registry[key].filter(instrumentation => {
    const config = autoConfig[instrumentation.instrumentationName] as Parameters<Instrumentation['setConfig']>[0];
    instrumentation.setConfig(config);
    if (config?.enabled === false) { instrumentation.disable(); return false; }
    instrumentation.enable();
    return true;
  });
}
