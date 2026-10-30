import { Context, SpanContext, createTraceState, diag } from '@opentelemetry/api';
import { Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { DataBudget } from '../memory/OwnedData';

/** Reject oversized ended spans before they enter the asynchronous export queue. */
export class SpanPayloadLimitProcessor implements SpanProcessor {
  private readonly resources = new WeakMap<Resource, Resource>();
  private warned = false;
  private droppedSpans = 0;
  constructor(private readonly delegate: SpanProcessor) {}
  onStart(span: Parameters<SpanProcessor['onStart']>[0], context: Context): void { this.delegate.onStart(span, context); }
  onEnd(span: ReadableSpan): void {
    let owned: ReadableSpan;
    try {
      const budget = new DataBudget();
      const name = budget.text(span.name);
      const status = { code: number(span.status.code), ...(span.status.message !== undefined ? { message: budget.text(span.status.message) } : {}) };
      const attributes = budget.attributes(span.attributes);
      if (span.events.length > 64 || span.links.length > 64) throw new Error('ELVEN_PAYLOAD_BUDGET');
      const events = span.events.map(event => {
        budget.spend(64);
        return { name: budget.text(event.name), time: snapshotTime(event.time),
          ...(event.attributes !== undefined ? { attributes: budget.attributes(event.attributes, 64) } : {}),
          ...(event.droppedAttributesCount !== undefined ? { droppedAttributesCount: number(event.droppedAttributesCount) } : {}) };
      });
      const links = span.links.map(link => {
        budget.spend(128);
        return { context: snapshotContext(link.context, budget),
          ...(link.attributes !== undefined ? { attributes: budget.attributes(link.attributes, 64) } : {}),
          ...(link.droppedAttributesCount !== undefined ? { droppedAttributesCount: number(link.droppedAttributesCount) } : {}) };
      });
      const context = snapshotContext(span.spanContext(), budget);
      const parent = span.parentSpanContext && snapshotContext(span.parentSpanContext, budget);
      const scope = span.instrumentationScope;
      owned = {
        name, kind: number(span.kind), spanContext: detachedSpanContext,
        ...(parent ? { parentSpanContext: parent } : {}),
        startTime: snapshotTime(span.startTime), endTime: snapshotTime(span.endTime),
        duration: snapshotTime(span.duration), ended: boolean(span.ended),
        status, attributes, events, links, resource: this.snapshotResource(span.resource),
        instrumentationScope: { name: budget.text(scope.name, 255),
          ...(scope.version !== undefined ? { version: budget.text(scope.version, 255) } : {}),
          ...(scope.schemaUrl !== undefined ? { schemaUrl: budget.text(scope.schemaUrl, 2048) } : {}) },
        droppedAttributesCount: number(span.droppedAttributesCount),
        droppedEventsCount: number(span.droppedEventsCount), droppedLinksCount: number(span.droppedLinksCount),
      };
      // The shared method uses only its receiver, not an onEnd lexical closure.
      Object.defineProperty(owned, '_ownedContext', { value: context });
    } catch {
      this.drop();
      return;
    }
    try { this.delegate.onEnd(owned); } catch { this.drop(); }
  }
  private snapshotResource(resource: Resource): Resource {
    const cached = this.resources.get(resource);
    if (cached) return cached;
    // Owned Node runtime disables async resource detection; never export a partial resource.
    if (resource.asyncAttributesPending) throw new Error('ELVEN_RESOURCE_PENDING');
    const budget = new DataBudget(131_072);
    const attributes = budget.attributes(resource.attributes, 256);
    const schemaUrl = resource.schemaUrl === undefined ? undefined : budget.text(resource.schemaUrl, 2048);
    const copy = resourceFromAttributes(attributes, schemaUrl === undefined ? undefined : { schemaUrl });
    this.resources.set(resource, copy);
    return copy;
  }
  forceFlush(): Promise<void> { return this.delegate.forceFlush(); }
  shutdown(): Promise<void> { return this.delegate.shutdown(); }
  getDroppedSpans(): number { return this.droppedSpans; }
  private drop(): void {
    this.droppedSpans = Math.min(Number.MAX_SAFE_INTEGER, this.droppedSpans + 1);
    if (!this.warned) {
      this.warned = true;
      try { diag.warn('ELVEN_SPAN_PAYLOAD_BUDGET'); } catch { /* No diagnostic recursion. */ }
    }
  }
}

function detachedSpanContext(this: ReadableSpan & { _ownedContext: SpanContext }): SpanContext {
  return this._ownedContext;
}

function snapshotContext(source: SpanContext, budget: DataBudget): SpanContext {
  const traceState = source.traceState?.serialize();
  return { traceId: budget.text(source.traceId, 32), spanId: budget.text(source.spanId, 16),
    traceFlags: number(source.traceFlags),
    ...(source.isRemote !== undefined ? { isRemote: boolean(source.isRemote) } : {}),
    ...(traceState === undefined ? {} : { traceState: createTraceState(budget.text(traceState, 512)) }) };
}

function number(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('ELVEN_PAYLOAD_BUDGET');
  return value;
}
function boolean(value: boolean): boolean {
  if (typeof value !== 'boolean') throw new Error('ELVEN_PAYLOAD_BUDGET');
  return value;
}
function snapshotTime(value: ReadableSpan['startTime']): ReadableSpan['startTime'] {
  return [number(value[0]), number(value[1])];
}
