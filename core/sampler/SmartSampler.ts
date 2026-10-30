import { Attributes, Context, diag, Link, SpanKind } from '@opentelemetry/api';
import { MatcherPolicy } from '../matcher/MatcherPolicy';
import { ownedString } from '../memory/OwnedData';
import { snapshotConfig } from '../memory/ConfigSnapshot';
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

interface ResolvedSamplingRule {
  key: string;
  literal?: string;
  regexIndex?: number;
  decision: SamplingDecision;
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
  private _rules: ResolvedSamplingRule[];
  private _matcher?: MatcherPolicy;
  private _closed = false;
  private _droppedInputs = 0;

  constructor(config: SmartSamplerConfig = {}) {
    config = snapshotConfig(config);
    const configuredRatio = config.ratio ?? 1.0;
    if (typeof configuredRatio !== 'number' || !Number.isFinite(configuredRatio)) throw new Error('ELVEN_SAMPLER_UNSUPPORTED_RULE');
    const ratio = Number.isFinite(configuredRatio)
      ? Math.max(0, Math.min(1, configuredRatio))
      : 1.0;
    this._ratioSampler = new TraceIdRatioBasedSampler(ratio);
    const rules = config.rules ?? [];
    if (!Array.isArray(rules) || rules.length > 32) throw new Error('ELVEN_SAMPLER_RULE_BUDGET');
    const patterns: RegExp[] = [];
    this._rules = Array.from(rules, rule => {
      if (!rule || typeof rule.attributeKey !== 'string' || rule.attributeKey.length > 128 ||
        ![SamplingDecision.NOT_RECORD, SamplingDecision.RECORD, SamplingDecision.RECORD_AND_SAMPLED].includes(rule.decision)) {
        throw new Error('ELVEN_SAMPLER_UNSUPPORTED_RULE');
      }
      if (typeof rule.attributeValue === 'string') {
        if (rule.attributeValue.length > 4096) throw new Error('ELVEN_SAMPLER_RULE_BUDGET');
        return { key: ownedString(rule.attributeKey, 128), literal: ownedString(rule.attributeValue, 4096), decision: rule.decision };
      }
      if (!(rule.attributeValue instanceof RegExp)) throw new Error('ELVEN_SAMPLER_UNSUPPORTED_RULE');
      const regexIndex = patterns.push(rule.attributeValue) - 1;
      return { key: ownedString(rule.attributeKey, 128), regexIndex, decision: rule.decision };
    });
    if (patterns.length > 0) this._matcher = new MatcherPolicy(patterns);
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    if (this._closed) return { decision: SamplingDecision.NOT_RECORD };
    // No matcher scope or per-span allocation when no custom RegExp is configured.
    let call: ReturnType<MatcherPolicy['begin']> | undefined;
    try {
      call = this._matcher?.begin();
      for (const rule of this._rules) {
        const descriptor = Object.getOwnPropertyDescriptor(attributes, rule.key);
        if (descriptor && !('value' in descriptor)) throw new Error('ELVEN_SAMPLER_INPUT_BUDGET');
        const val: unknown = descriptor?.value;
        if (typeof val !== 'string') continue;
        if (rule.literal !== undefined && rule.literal === val) return { decision: rule.decision };
        if (rule.regexIndex !== undefined && call && this._matcher) {
          const matched = this._matcher.match(rule.regexIndex, val.slice(0, 4096), call);
          if (call.failed) return this.dropInput();
          if (matched) return { decision: rule.decision };
        }
      }
      return this._ratioSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
    } catch {
      return this.dropInput();
    } finally {
      try { call?.close(); }
      catch { this._closed = true; this._rules = []; }
    }
  }

  toString(): string {
    return `SmartSampler(rules=${this._rules.length}, ratio=${this._ratioSampler.toString()})`;
  }

  close(): void { this._closed = true; this._rules = []; this._matcher?.close(); }
  getDroppedInputs(): number { return this._droppedInputs; }
  private dropInput(): SamplingResult {
    this._droppedInputs = Math.min(Number.MAX_SAFE_INTEGER, this._droppedInputs + 1);
    if (this._droppedInputs === 1) {
      try { diag.warn('ELVEN_SAMPLER_INPUT_BUDGET'); } catch { /* No diagnostic recursion. */ }
    }
    return { decision: SamplingDecision.NOT_RECORD };
  }
}

const ownedSamplers = new WeakMap<Sampler, SmartSampler>();

export function closeSmartSampler(sampler?: Sampler): void {
  if (!sampler) return;
  ownedSamplers.get(sampler)?.close();
  ownedSamplers.delete(sampler);
}

/**
 * Create a ParentBased sampler that uses SmartSampler as the root.
 */
export function createSmartSampler(config: SmartSamplerConfig): Sampler {
  const root = new SmartSampler(config);
  const sampler = new ParentBasedSampler({
    root,
  });
  ownedSamplers.set(sampler, root);
  return sampler;
}
