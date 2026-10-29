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
const SECRET_KEYS = new Set(['db.user', 'db.user.name', 'http.request.header.authorization', 'http.request.header.cookie', 'http.response.header.set_cookie']);

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
    const sanitized = spans.map(span => Object.create(span, {
      attributes: { value: this.sanitizeAttributes(span.attributes) },
      events: { value: span.events.map(event => ({ ...event, attributes: this.sanitizeAttributes(event.attributes ?? {}) })) },
      links: { value: span.links.map(link => ({ ...link, attributes: this.sanitizeAttributes(link.attributes ?? {}) })) },
    }) as ReadableSpan);
    this.delegate.export(sanitized, resultCallback);
  }

  public async forceFlush(): Promise<void> {
    if (typeof this.delegate.forceFlush === 'function') {
      await this.delegate.forceFlush();
    }
  }

  public async shutdown(): Promise<void> {
    await this.delegate.shutdown();
  }

  private sanitizeAttributes(source: Attributes): Attributes {
    const attributes = { ...source };
    for (const [key, value] of Object.entries(attributes)) {
      if (this._allowRawAttributesSet.has(key)) continue;
      if (SECRET_KEYS.has(key)) { attributes[key] = REDACTED; continue; }
      if (key === 'url.query') { attributes[key] = REDACTED; continue; }
      if (['url.full', 'http.url', 'http.target'].includes(key) && typeof value === 'string') {
        attributes[key] = redactUrl(value);
        continue;
      }

      if (this.privacy.redactDbStatement && DB_STATEMENT_KEYS.has(key)) {
        attributes[key] = REDACTED;
        continue;
      }

      if (this.privacy.hashUserId && USER_ID_KEYS.has(key)) {
        attributes[key] = hashValue(value);
      }
    }
    return attributes;
  }
}

function hashValue(value: unknown): string {
  const normalized = typeof value === 'string'
    ? value
    : (JSON.stringify(value) ?? String(value));
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value, 'http://relative.invalid');
    const hasQuery = url.search.length > 0;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
    return `${absolute ? url.toString() : url.pathname}${hasQuery ? '?[REDACTED]' : ''}`;
  } catch { return REDACTED; }
}
