import { createHash } from 'node:crypto';
import { Attributes } from '@opentelemetry/api';
import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

export interface ResolvedPrivacyConfig {
  redactDbStatement: boolean;
  hashUserId: boolean;
  allowRawAttributes: string[];
}

const REDACTED = '[REDACTED]';

const DB_STATEMENT_KEYS = new Set<string>(['db.statement', 'db.query.text']);
const USER_ID_KEYS = new Set<string>(['user.id', 'enduser.id']);

export class RedactingSpanExporter implements SpanExporter {
  private _allowRawAttributesSet: Set<string>;

  constructor(
    private readonly delegate: SpanExporter,
    private readonly privacy: ResolvedPrivacyConfig
  ) {
    this._allowRawAttributesSet = new Set(privacy.allowRawAttributes);
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number; error?: Error }) => void
  ): void {
    for (const span of spans) {
      this.sanitizeSpanAttributes(span);
    }
    this.delegate.export(spans, resultCallback);
  }

  public async forceFlush(): Promise<void> {
    if (typeof this.delegate.forceFlush === 'function') {
      await this.delegate.forceFlush();
    }
  }

  public async shutdown(): Promise<void> {
    await this.delegate.shutdown();
  }

  private sanitizeSpanAttributes(span: ReadableSpan): void {
    // SDK keeps attributes as a mutable map object at export time.
    const attributes = span.attributes as Attributes;
    for (const [key, value] of Object.entries(attributes)) {
      if (this._allowRawAttributesSet.has(key)) continue;

      if (this.privacy.redactDbStatement && DB_STATEMENT_KEYS.has(key)) {
        attributes[key] = REDACTED;
        continue;
      }

      if (this.privacy.hashUserId && USER_ID_KEYS.has(key)) {
        attributes[key] = hashValue(value);
      }
    }
  }
}

function hashValue(value: unknown): string {
  const normalized = typeof value === 'string'
    ? value
    : (JSON.stringify(value) ?? String(value));
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
