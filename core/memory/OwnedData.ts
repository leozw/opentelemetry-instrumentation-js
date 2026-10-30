import { Attributes, AttributeValue } from '@opentelemetry/api';

export function ownedString<T extends string | undefined>(value: T, maximum: number): T {
  if (value === undefined) return value;
  if (typeof value !== 'string' || value.length > maximum) throw new Error('ELVEN_METADATA_BUDGET');
  // Copy before validation/matching; UTF-8 would silently replace lone surrogates.
  const copy = Buffer.from(value, 'utf16le').toString('utf16le');
  for (let index = 0; index < copy.length; index++) {
    const unit = copy.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = copy.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('ELVEN_METADATA_UNSUPPORTED_UNICODE');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('ELVEN_METADATA_UNSUPPORTED_UNICODE');
  }
  return copy as T;
}

export class DataBudget {
  constructor(private remaining = 65_536) {
    if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > 131_072) throw new Error('ELVEN_PAYLOAD_BUDGET');
  }

  spend(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remaining) throw new Error('ELVEN_PAYLOAD_BUDGET');
    this.remaining -= bytes;
  }

  text(value: string, maximum = 65_536): string {
    if (typeof value !== 'string' || value.length > maximum) throw new Error('ELVEN_PAYLOAD_BUDGET');
    this.spend(value.length * 2);
    return ownedString(value, maximum);
  }

  attributes(source: Attributes, maximum = 128): Attributes {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('ELVEN_PAYLOAD_BUDGET');
    const result: Attributes = Object.create(null);
    let count = 0;
    for (const key in source) {
      if (++count > maximum) throw new Error('ELVEN_PAYLOAD_BUDGET');
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor) continue;
      if (!('value' in descriptor)) throw new Error('ELVEN_PAYLOAD_BUDGET');
      this.spend(32);
      const name = this.text(key), value: unknown = descriptor.value;
      if (Array.isArray(value)) {
        if (value.length > 64) throw new Error('ELVEN_PAYLOAD_BUDGET');
        const array: (string | number | boolean | null | undefined)[] = [];
        for (let index = 0; index < value.length; index++) {
          const item = Object.getOwnPropertyDescriptor(value, String(index));
          if (item && !('value' in item)) throw new Error('ELVEN_PAYLOAD_BUDGET');
          array.push(this.scalar(item?.value));
        }
        result[name] = array as AttributeValue;
      } else result[name] = this.scalar(value) as AttributeValue | undefined;
    }
    return result;
  }

  private scalar(value: unknown): string | number | boolean | null | undefined {
    if (typeof value === 'string') return this.text(value);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('ELVEN_PAYLOAD_BUDGET');
    if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') {
      this.spend(16); return value;
    }
    throw new Error('ELVEN_PAYLOAD_BUDGET');
  }
}
