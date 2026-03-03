import { Attributes, Histogram, Meter, metrics } from '@opentelemetry/api';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import type { ServerResponse } from 'http';
import { ResolvedPrivacyConfig } from '../core/exporter';
import {
  INSTRUMENTATION_DEFAULTS,
  INSTRUMENTATION_ENV_KEYS,
  InstrumentationsConfig,
  resolveEnabled,
} from './config';
import { resolveInstrumentations } from './registry';

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

  const builtIn: Instrumentation[] = [];

  if (isBuiltInEnabled('http', options.config)) {
    builtIn.push(
      new HttpInstrumentation({
        requestHook: (_span, request) => {
          if (!('headers' in request)) return;
          const size = request.headers['content-length'];
          if (!size) return;
          const sizeVal = parseInt(String(size), 10);
          if (!isNaN(sizeVal)) {
            getHistograms();
          }
        },
        applyCustomAttributesOnSpan: (_span, request, response) => {
          if (!('headers' in request)) return;
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
      })
    );
  }

  if (isBuiltInEnabled('express', options.config)) {
    builtIn.push(new ExpressInstrumentation({}));
  }

  if (isBuiltInEnabled('fastify', options.config)) {
    builtIn.push(new FastifyInstrumentation({}));
  }

  if (isBuiltInEnabled('graphql', options.config)) {
    builtIn.push(
      new GraphQLInstrumentation({
        mergeItems: true,
        allowValues: false,
      })
    );
  }

  const discovered = resolveInstrumentations({
    ...(options.config ? { config: options.config } : {}),
    privacy: options.privacy,
  });

  return [...builtIn, ...discovered];
}

function isBuiltInEnabled(name: 'http' | 'express' | 'fastify' | 'graphql', config?: InstrumentationsConfig): boolean {
  return resolveEnabled(
    config?.[name]?.enabled,
    INSTRUMENTATION_ENV_KEYS[name],
    INSTRUMENTATION_DEFAULTS[name]
  );
}
