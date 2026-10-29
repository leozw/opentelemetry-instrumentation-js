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
    const sanitized = spans.map(span => {
      const attributes = this.sanitizeAttributes(span.attributes);
      const events = span.events.map(event => {
        const attributes = event.attributes && this.sanitizeAttributes(event.attributes);
        return attributes === event.attributes ? event : { ...event, attributes };
      });
      const links = span.links.map(link => {
        const attributes = link.attributes && this.sanitizeAttributes(link.attributes);
        return attributes === link.attributes ? link : { ...link, attributes };
      });
      if (attributes === span.attributes && events.every((event, i) => event === span.events[i])
        && links.every((link, i) => link === span.links[i])) return span;
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

  private sanitizeAttributes(source: Attributes): Attributes {
    let attributes = source;
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      const value = source[key];
      if (this._allowRawAttributesSet.has(key)) continue;
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
