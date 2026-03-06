import { Attributes, Histogram, Meter, metrics } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Instrumentation } from '@opentelemetry/instrumentation';
import type { ServerResponse } from 'http';
import { ResolvedPrivacyConfig } from '../core/exporter';
import { InstrumentationsConfig } from './config';
import { getAutoInstrumentationsConfig } from './registry';

export interface BuildInstrumentationsOptions {
  config?: InstrumentationsConfig;
  privacy: ResolvedPrivacyConfig;
}

export function getCoreInstrumentations(options: BuildInstrumentationsOptions): Instrumentation[] {
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
    return { requestSizeHistogram, responseSizeHistogram };
  };

  const autoConfig = getAutoInstrumentationsConfig(options);

  // Apply our custom HTTP hooks on top of whatever config was resolved
  const httpConfig = (autoConfig['@opentelemetry/instrumentation-http'] as Record<string, unknown>) || {};
  if (httpConfig.enabled !== false) {
    autoConfig['@opentelemetry/instrumentation-http'] = {
      ...httpConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestHook: (_span: any, request: any) => {
        if (!request || typeof request !== 'object' || !('headers' in request)) return;
        const size = request.headers['content-length'];
        if (!size) return;
        const sizeVal = parseInt(String(size), 10);
        if (!isNaN(sizeVal)) {
          getHistograms();
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyCustomAttributesOnSpan: (_span: any, request: any, response: any) => {
        if (!request || typeof request !== 'object' || !('headers' in request)) return;
        const castResponse = response as ServerResponse;
        const attributes: Attributes = {};
        if (request.method) attributes['http.request.method'] = request.method;
        if (castResponse.statusCode) attributes['http.response.status_code'] = castResponse.statusCode;

        const { requestSizeHistogram: reqHist, responseSizeHistogram: resHist } = getHistograms();
        if (!reqHist || !resHist) return;

        const respSize = castResponse.getHeader('content-length');
        if (respSize) {
          const val = parseInt(String(respSize), 10);
          if (!isNaN(val)) {
            resHist.record(val, attributes);
          }
        }

        const reqSize = request.headers['content-length'];
        if (reqSize) {
          const val = parseInt(String(reqSize), 10);
          if (!isNaN(val)) {
            reqHist.record(val, attributes);
          }
        }
      },
    };
  }

  return getNodeAutoInstrumentations(autoConfig);
}

