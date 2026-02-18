import {
  context as apiContext,
  Context,
  Span,
  SpanOptions,
  SpanStatusCode,
  trace,
  Tracer,
} from '@opentelemetry/api';

/**
 * TracerFacade
 * 
 * High-performance wrapper around OpenTelemetry Tracer.
 * optimizing common patterns like "create span, run function, end span".
 */
export class TracerFacade {
  private _tracer: Tracer;

  constructor(name: string, version?: string) {
    this._tracer = trace.getTracer(name, version);
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
    const span = this._tracer.startSpan(name, options, parentContext);
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
              span.end();
            });
        }
        span.end();
        return result;
      } catch (err) {
        this.handleError(span, err);
        span.end();
        throw err;
      }
    });
  }

  /**
   * Start a manual span. User is responsible for ending it.
   */
  public startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    return this._tracer.startSpan(name, options, context);
  }

  private handleError(span: Span, err: unknown) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    span.recordException(err instanceof Error ? err : String(err));
  }
}
