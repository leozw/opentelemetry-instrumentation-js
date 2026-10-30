import { context, propagation, TextMapPropagator } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { NetworkPropagator } from '../../core/propagation';

interface ProcessBootstrap {
  contextManager: AsyncLocalStorageContextManager;
  propagator: TextMapPropagator;
}

const key = Symbol.for('elven.observability.node.bootstrap.v2');
const registry = globalThis as typeof globalThis & { [key]?: ProcessBootstrap };

/** Process bootstrap is not a per-generation registry or SDK shutdown target. */
export function registerProcessBootstrap(propagator?: TextMapPropagator | null): void {
  const bootstrap = registry[key] ??= {
    contextManager: new AsyncLocalStorageContextManager().enable(),
    propagator: NetworkPropagator.create(),
  };
  // Public registration refuses an existing owner. There are no public identity
  // getters permitting safe global compare/remove at pipeline shutdown.
  context.setGlobalContextManager(bootstrap.contextManager);
  if (propagator !== null) propagation.setGlobalPropagator(propagator ?? bootstrap.propagator);
}
