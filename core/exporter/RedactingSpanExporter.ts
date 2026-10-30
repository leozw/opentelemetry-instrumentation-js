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
const URL_KEYS = new Set(['url.full', 'http.url', 'http.target']);

export class RedactingSpanExporter implements SpanExporter {
  private readonly attributes: AttributePrivacy;

  constructor(
    private readonly delegate: SpanExporter,
    privacy: ResolvedPrivacyConfig
  ) {
    this.attributes = new AttributePrivacy(privacy);
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number; error?: Error }) => void
  ): void {
    const sanitized = spans.map(span => {
      const attributes = this.sanitizeAttributes(span.attributes);
      const events = this.sanitizeItems(span.events);
      const links = this.sanitizeItems(span.links);
      if (attributes === span.attributes && events === span.events && links === span.links) return span;
      return Object.create(span, {
        attributes: { value: attributes }, events: { value: events }, links: { value: links },
      }) as ReadableSpan;
    });
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

  private sanitizeItems<T extends { attributes?: Attributes }>(source: T[]): T[] {
    let result = source;
    for (let i = 0; i < source.length; i++) {
      const item = source[i];
      if (!item || item.attributes === undefined) continue;
      const attributes = this.sanitizeAttributes(item.attributes);
      if (attributes !== item.attributes) {
        if (result === source) result = source.slice();
        result[i] = { ...item, attributes };
      }
    }
    return result;
  }

  private sanitizeAttributes(source: Attributes): Attributes {
    return this.attributes.sanitize(source);
  }
}

/** Same known-key policy for owned Resource, metric and span attributes. */
export class AttributePrivacy {
  private readonly allowRaw: Set<string>;
  constructor(private readonly privacy: ResolvedPrivacyConfig) {
    this.allowRaw = new Set(privacy.allowRawAttributes);
  }
  sanitize(source: Attributes): Attributes {
    let attributes = source;
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      if (this.allowRaw.has(key)) continue;
      let sanitized = value;
      if (SECRET_KEYS.has(key) || key === 'url.query'
        || (this.privacy.redactDbStatement && DB_STATEMENT_KEYS.has(key))) sanitized = REDACTED;
      else if (URL_KEYS.has(key) && typeof value === 'string') sanitized = redactUrl(value);
      else if (this.privacy.hashUserId && USER_ID_KEYS.has(key)) sanitized = hashValue(value);
      if (sanitized !== value) {
        if (attributes === source) attributes = { ...source };
        attributes[key] = sanitized;
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
