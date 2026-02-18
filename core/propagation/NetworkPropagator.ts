import { TextMapPropagator } from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';

/**
 * Universal Propagation Configuration.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class NetworkPropagator {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() { }

  public static create(customPropagators: TextMapPropagator[] = []): TextMapPropagator {
    return new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
        ...customPropagators,
      ],
    });
  }
}
