import { ownedString } from './OwnedData';

const sourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get;
const flagGetters = ['hasIndices', 'global', 'ignoreCase', 'multiline', 'dotAll', 'unicode', 'unicodeSets', 'sticky']
  .map((name, index) => ({ get: Object.getOwnPropertyDescriptor(RegExp.prototype, name)?.get, flag: 'dgimsuvy'[index] }));

/** Plain config data only; callbacks are opaque identities, not copied executable state. */
export function snapshotConfig<T>(source: T): T {
  let remaining = 1_048_576, values = 0, containers = 0, visited = 0;
  const ancestors = new Set<object>();
  const spend = (bytes: number) => {
    if (bytes > remaining) throw new Error('ELVEN_CONFIG_BUDGET');
    remaining -= bytes;
  };
  const text = (value: string) => {
    if (value.length > 65_536) throw new Error('ELVEN_CONFIG_BUDGET');
    spend(value.length * 2);
    return ownedString(value, 65_536);
  };
  const copy = (value: unknown, depth: number, path: string): unknown => {
    if (++values > 4096 || depth > 12) throw new Error('ELVEN_CONFIG_BUDGET');
    spend(16);
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('ELVEN_CONFIG_VALUE');
    if (value === null || value === undefined || typeof value === 'boolean'
      || typeof value === 'number' || typeof value === 'function') return value;
    if (typeof value !== 'object') throw new Error('ELVEN_CONFIG_VALUE');
    if (++containers > 512 || ancestors.has(value)) throw new Error('ELVEN_CONFIG_BUDGET');
    spend(64);
    if (value instanceof RegExp && Object.getPrototypeOf(value) === RegExp.prototype && sourceGetter) {
      const pattern: string = sourceGetter.call(value);
      if (pattern.length > 256) throw new Error('ELVEN_MATCHER_UNSUPPORTED_PATTERN');
      // Intrinsics do not consult caller .source/.flags getters, .test or lastIndex.
      const flags = flagGetters.filter(entry => entry.get?.call(value)).map(entry => entry.flag).join('');
      return new RegExp(text(pattern), text(flags));
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error('ELVEN_CONFIG_VALUE');
    }
    const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value as number : 0;
    if (length > 4096) throw new Error('ELVEN_CONFIG_BUDGET');
    if (array && (path === 'rules' || path === 'tracing.sampling.rules') && length > 32) {
      throw new Error('ELVEN_SAMPLER_RULE_BUDGET');
    }
    const result: Record<string, unknown> | unknown[] = array ? new Array(length) : Object.create(null);
    ancestors.add(value);
    try {
      for (const key in value) {
        if (++visited > 4096) throw new Error('ELVEN_CONFIG_BUDGET');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable) continue;
        if (!('value' in descriptor)) throw new Error('ELVEN_CONFIG_ACCESSOR');
        const name = text(key);
        const owned = copy(descriptor.value, depth + 1, path ? `${path}.${key}` : key);
        Object.defineProperty(result, name, { value: owned, enumerable: true });
      }
    } finally { ancestors.delete(value); }
    return Object.freeze(result);
  };
  return copy(source, 0, '') as T;
}

export function ownBoolean(source: unknown, key: string): boolean {
  if (!source || typeof source !== 'object') return false;
  try { return Object.getOwnPropertyDescriptor(source, key)?.value === true; }
  catch { return false; }
}

/** Transfers shutdown ownership once, including rollback before provider construction. */
export function onceShutdown<T extends { shutdown(): Promise<void> }>(owner: T): T {
  const shutdown = owner.shutdown.bind(owner);
  let pending: Promise<void> | undefined;
  owner.shutdown = () => pending ??= Promise.resolve().then(shutdown);
  return owner;
}
