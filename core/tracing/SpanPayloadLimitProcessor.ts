import { Context, Attributes } from '@opentelemetry/api';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/** Reject oversized ended spans before they enter the asynchronous export queue. */
export class SpanPayloadLimitProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}
  onStart(span: Parameters<SpanProcessor['onStart']>[0], context: Context): void { this.delegate.onStart(span, context); }
  onEnd(span: ReadableSpan): void {
    let bytes = span.name.length * 2 + (span.status.message?.length ?? 0) * 2;
    const count = (attributes: Attributes) => {
      for (const [key, value] of Object.entries(attributes)) {
        bytes += key.length * 2 + 32;
        const values = Array.isArray(value) ? value : [value];
        if (values.length > 64) { bytes = 65_537; return; }
        for (const item of values) bytes += typeof item === 'string' ? item.length * 2 : 16;
        if (bytes > 65_536) return;
      }
    };
    count(span.attributes);
    for (const event of span.events) {
      if (bytes > 65_536) return;
      bytes += event.name.length * 2 + 64;
      count(event.attributes ?? {});
    }
    for (const link of span.links) {
      if (bytes > 65_536) return;
      bytes += 128;
      count(link.attributes ?? {});
    }
    if (bytes <= 65_536) this.delegate.onEnd(span);
  }
  forceFlush(): Promise<void> { return this.delegate.forceFlush(); }
  shutdown(): Promise<void> { return this.delegate.shutdown(); }
}
