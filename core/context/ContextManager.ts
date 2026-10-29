import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

// Keep the public class while using upstream's complete listener identity and
// EventEmitter binding implementation, including prepend/once/remove variants.
export class UniversalContextManager extends AsyncLocalStorageContextManager {}
