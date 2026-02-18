import { Context, ContextManager as OtelContextManager, ROOT_CONTEXT } from '@opentelemetry/api';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

export class UniversalContextManager implements OtelContextManager {
  private _storage: AsyncLocalStorage<Context>;

  constructor() {
    this._storage = new AsyncLocalStorage<Context>();
  }

  public active(): Context {
    return this._storage.getStore() ?? ROOT_CONTEXT;
  }

  public with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this._storage.run(context, cb as any, ...args);
  }

  public bind<T>(context: Context, target: T): T {
    if (target instanceof EventEmitter) {
      return this._bindEventEmitter(context, target) as unknown as T;
    }

    if (typeof target === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      return this._bindFunction(context, target as unknown as Function) as unknown as T;
    }

    return target;
  }

  public enable(): this {
    return this;
  }

  public disable(): this {
    this._storage.disable();
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private _bindFunction(context: Context, fn: Function): Function {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    const bound = function (this: unknown, ...args: unknown[]) {
      return manager.with(context, () => fn.apply(this, args));
    };
    Object.defineProperty(bound, 'length', { value: fn.length });
    Object.defineProperty(bound, 'name', { value: fn.name });
    return bound;
  }

  private _bindEventEmitter(context: Context, ee: EventEmitter): EventEmitter {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const map = new WeakMap<Function, Function>();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const contextWrapper = (listener: Function) => {
      let wrapped = map.get(listener);
      if (!wrapped) {
        wrapped = this._bindFunction(context, listener);
        map.set(listener, wrapped);
      }
      return wrapped;
    };

    this._patchEmitterMethod(ee, 'on', contextWrapper);
    this._patchEmitterMethod(ee, 'addListener', contextWrapper);
    this._patchEmitterMethod(ee, 'off', contextWrapper);
    this._patchEmitterMethod(ee, 'removeListener', contextWrapper);
    this._patchEmitterMethod(ee, 'once', contextWrapper);

    return ee;
  }

  private _patchEmitterMethod(
    ee: EventEmitter,
    method: 'on' | 'addListener' | 'off' | 'removeListener' | 'once',
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    wrapper: (fn: Function) => Function
  ) {
    const original = ee[method];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ee[method] = function (event: string | symbol, listener: (...args: any[]) => void) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return original.call(this, event, wrapper(listener) as any);
    };
  }
}
