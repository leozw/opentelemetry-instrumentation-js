import { Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import {
  ParentBasedSampler,
  Sampler,
  SamplingDecision,
  SamplingResult,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';

export interface SamplingRule {
  attributeKey: string;
  attributeValue: string | RegExp;
  decision: SamplingDecision;
}

export interface SmartSamplerConfig {
  ratio?: number; // 0.0 to 1.0
  rules?: SamplingRule[];
}

/**
 * SmartSampler
 * 
 * Implements "Rules-based" sampling at Head.
 * Priority:
 * 1. Rules (e.g. specific routes, user.id)
 * 2. Probabilistic (TraceIdRatioBased)
 */
export class SmartSampler implements Sampler {
  private _ratioSampler: Sampler;
  private _rules: SamplingRule[];

  constructor(config: SmartSamplerConfig = {}) {
    this._ratioSampler = new TraceIdRatioBasedSampler(config.ratio ?? 1.0);
    this._rules = config.rules ?? [];
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    // 1. Check rules
    for (const rule of this._rules) {
      const val = attributes[rule.attributeKey];
      if (val !== undefined) {
        if (rule.attributeValue === val) {
          return { decision: rule.decision };
        }
        if (rule.attributeValue instanceof RegExp && typeof val === 'string' && rule.attributeValue.test(val)) {
          return { decision: rule.decision };
        }
      }
    }

    // 2. Fallback to Ratio
    return this._ratioSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `SmartSampler(rules=${this._rules.length}, ratio=${this._ratioSampler.toString()})`;
  }
}

/**
 * Create a ParentBased sampler that uses SmartSampler as the root.
 */
export function createSmartSampler(config: SmartSamplerConfig): Sampler {
  const root = new SmartSampler(config);
  return new ParentBasedSampler({
    root,
  });
}
