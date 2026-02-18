/**
 * Core Instrumentations Module
 *
 * Composes:
 *   1. Built-in instrumentations (HTTP, Express, Fastify, GraphQL) — always loaded
 *   2. Auto-discovered instrumentations from the registry — loaded only if the
 *      target module is installed and not disabled via env var
 *   3. Custom HTTP body size metrics (lazy-initialized)
 */
import { Attributes, metrics } from '@opentelemetry/api';
import { Instrumentation } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IncomingMessage, ServerResponse } from 'http';
import { resolveInstrumentations } from './registry';

export function getCoreInstrumentations(): Instrumentation[] {
  // ── Lazy-initialized custom body size metrics ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let meter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let requestSizeHistogram: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let responseSizeHistogram: any;

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

  // ── Built-in instrumentations (always active) ──
  const builtIn: Instrumentation[] = [
    new HttpInstrumentation({
      requestHook: (span, request) => {
        if (request instanceof IncomingMessage) {
          const size = request.headers['content-length'];
          if (size) {
            const sizeVal = parseInt(size as string, 10);
            if (!isNaN(sizeVal)) {
              getHistograms(); // ensure initialized
            }
          }
        }
      },
      applyCustomAttributesOnSpan: (span, request, response) => {
        if (request instanceof IncomingMessage) {
          const castResponse = response as ServerResponse;

          const attributes: Attributes = {};
          if (request.method) attributes['http.method'] = request.method;
          if (castResponse.statusCode) attributes['http.status_code'] = castResponse.statusCode;

          const { requestSizeHistogram: reqHist, responseSizeHistogram: resHist } = getHistograms();

          // Response body size
          const respSize = castResponse.getHeader('content-length');
          if (respSize) {
            const val = parseInt(String(respSize), 10);
            if (!isNaN(val)) {
              resHist.record(val, attributes);
            }
          }

          // Request body size
          const reqSize = (request as IncomingMessage).headers['content-length'];
          if (reqSize) {
            const val = parseInt(String(reqSize), 10);
            if (!isNaN(val)) {
              reqHist.record(val, attributes);
            }
          }
        }
      },
    }),
    new ExpressInstrumentation({}),
    new FastifyInstrumentation({}),
    new GraphQLInstrumentation({
      mergeItems: true,
      allowValues: true,
    }),
  ];

  // ── Auto-discovered instrumentations from registry ──
  const discovered = resolveInstrumentations();

  return [...builtIn, ...discovered];
}
