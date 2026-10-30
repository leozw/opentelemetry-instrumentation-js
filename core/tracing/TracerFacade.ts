import {
  context as apiContext,
  Context,
  Span,
  SpanOptions,
  SpanStatusCode,
  trace,
  Tracer,
  INVALID_SPAN_CONTEXT,
} from '@opentelemetry/api';
import { ownedString } from '../memory/OwnedData';

/**
 * TracerFacade
 * 
 * High-performance wrapper around OpenTelemetry Tracer.
 * optimizing common patterns like "create span, run function, end span".
 */
export class TracerFacade {
  private _tracer: Tracer;

  constructor(name: string, version?: string, tracer?: Tracer) {
    this._tracer = tracer ?? trace.getTracer(ownedString(name, 255), ownedString(version, 255));
  }

  /**
   * Executes a callback within a new span.
   * Automatically handles errors and span ending.
   */
  public withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    options?: SpanOptions,
    parentContext: Context = apiContext.active()
  ): T | Promise<T> {
    const span = this.startSpan(name, options, parentContext);
    const ctx = trace.setSpan(parentContext, span);

    return apiContext.with(ctx, () => {
      try {
        const result = fn(span);
        if (result instanceof Promise) {
          return result
            .catch((err) => {
              this.handleError(span, err);
              throw err;
            })
            .finally(() => {
              this.end(span);
            });
        }
        this.end(span);
        return result;
      } catch (err) {
        this.handleError(span, err);
        this.end(span);
        throw err;
      }
    });
  }

  /**
   * Start a manual span. User is responsible for ending it.
   */
  public startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    try { return this._tracer.startSpan(name, options, context); }
    catch { return trace.wrapSpanContext(INVALID_SPAN_CONTEXT); }
  }

  private handleError(span: Span, err: unknown) {
    try {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : String(err));
    } catch { /* Telemetry must not replace the business exception. */ }
  }

  private end(span: Span): void {
    try { span.end(); } catch { /* Keep the business result or original exception. */ }
  }
}
