import {
  Attributes,
  diag,
  Counter,
  Histogram,
  Meter,
  metrics,
  ObservableGauge,
  UpDownCounter,
} from '@opentelemetry/api';
import { DataBudget, ownedString } from '../memory/OwnedData';
import { AttributePrivacy, ResolvedPrivacyConfig } from '../exporter/RedactingSpanExporter';

const noopCounter: Counter = Object.freeze({ add: () => undefined });
const noopHistogram: Histogram = Object.freeze({ record: () => undefined });

/**
 * MetricFacade
 * 
 * Unified interface for recording metrics.
 * Enforces standard naming and best practices.
 */
export class MetricFacade {
  private _meter: Meter;
  private _counters = new Map<string, Counter>();
  private _histograms = new Map<string, Histogram>();
   
  private _gauges = new Map<string, ObservableGauge>();
  private _upDownCounters = new Map<string, UpDownCounter>();
  private readonly maxInstruments = 128;
  private droppedInstruments = 0;
  private droppedMeasurements = 0;
  private readonly reported = new Set<string>();
  private readonly privacy: AttributePrivacy;

  constructor(name: string, version?: string, meter?: Meter, privacy: ResolvedPrivacyConfig = { redactDbStatement: true, hashUserId: true, allowRawAttributes: [] }) {
    const scope = ownedString(name, 255), scopeVersion = ownedString(version, 255);
    this._meter = meter ?? metrics.getMeter(scope, scopeVersion);
    this.privacy = new AttributePrivacy(privacy);
  }

  public getCounter(name: string, description?: string): Counter {
    const metadata = this.prepareInstrument(name, description);
    if (!metadata) return noopCounter;
    ({ name, description } = metadata);
    if (!this._counters.has(name)) {
      if (!this.instrumentCapacity()) return noopCounter;
      const instrument = this._meter.createCounter(name, description ? { description } : undefined);
      this._counters.set(name, { add: (value, attributes, context) => {
        const snapshot = this.measurementAttributes(attributes, value);
        if (snapshot !== null) instrument.add(value, snapshot, context);
      } });
    }
    const counter = this._counters.get(name);
    if (!counter) throw new Error('ELVEN_METRIC_CREATION_FAILED');
    return counter;
  }

  public getHistogram(name: string, description?: string): Histogram {
    const metadata = this.prepareInstrument(name, description);
    if (!metadata) return noopHistogram;
    ({ name, description } = metadata);
    if (!this._histograms.has(name)) {
      if (!this.instrumentCapacity()) return noopHistogram;
      const instrument = this._meter.createHistogram(name, description ? { description } : undefined);
      this._histograms.set(name, { record: (value, attributes, context) => {
        const snapshot = this.measurementAttributes(attributes, value);
        if (snapshot !== null) instrument.record(value, snapshot, context);
      } });
    }
    const histogram = this._histograms.get(name);
    if (!histogram) throw new Error('ELVEN_METRIC_CREATION_FAILED');
    return histogram;
  }

  public getUpDownCounter(name: string, description?: string): UpDownCounter {
    const metadata = this.prepareInstrument(name, description);
    if (!metadata) return noopCounter;
    ({ name, description } = metadata);
    if (!this._upDownCounters.has(name)) {
      if (!this.instrumentCapacity()) return noopCounter;
      const instrument = this._meter.createUpDownCounter(name, description ? { description } : undefined);
      this._upDownCounters.set(name, { add: (value, attributes, context) => {
        const snapshot = this.measurementAttributes(attributes, value);
        if (snapshot !== null) instrument.add(value, snapshot, context);
      } });
    }
    const counter = this._upDownCounters.get(name);
    if (!counter) throw new Error('ELVEN_METRIC_CREATION_FAILED');
    return counter;
  }

  /**
   * Helper to record a simple value to a histogram (e.g. latency)
   */
  public recordHistogram(name: string, value: number, attributes?: Attributes) {
    this.getHistogram(name).record(value, attributes);
  }

  /**
   * Helper to increment a counter
   */
  public increment(name: string, value = 1, attributes?: Attributes) {
    this.getCounter(name).add(value, attributes);
  }

  public getDroppedInstruments(): number { return this.droppedInstruments; }
  public getDroppedMeasurements(): number { return this.droppedMeasurements; }

  private prepareInstrument(name: string, description?: string): { name: string; description?: string } | undefined {
    try {
      if (typeof name !== 'string' || (description !== undefined && typeof description !== 'string')) throw new Error('ELVEN_METRIC_METADATA_BUDGET');
      return { name: ownedString(name, 255), ...(description !== undefined ? { description: ownedString(description, 1024) } : {}) };
    } catch {
      this.droppedInstruments = Math.min(Number.MAX_SAFE_INTEGER, this.droppedInstruments + 1);
      this.report('ELVEN_METRIC_METADATA_BUDGET');
      return undefined;
    }
  }

  private instrumentCapacity(): boolean {
    if (this._counters.size + this._histograms.size + this._upDownCounters.size < this.maxInstruments) return true;
    this.droppedInstruments = Math.min(Number.MAX_SAFE_INTEGER, this.droppedInstruments + 1);
    this.report('ELVEN_METRIC_METADATA_BUDGET');
    return false;
  }

  private measurementAttributes(attributes: Attributes | undefined, value: number): Attributes | undefined | null {
    try {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('ELVEN_METRIC_ATTRIBUTE_BUDGET');
      if (attributes === undefined) return undefined;
      const owned = new DataBudget().attributes(attributes);
      const sanitized = this.privacy.sanitize(owned);
      return sanitized === owned ? owned : new DataBudget().attributes(sanitized);
    }
    catch { this.droppedMeasurements = Math.min(Number.MAX_SAFE_INTEGER, this.droppedMeasurements + 1); this.report('ELVEN_METRIC_ATTRIBUTE_BUDGET'); return null; }
  }

  private report(code: string): void {
    if (this.reported.has(code)) return;
    this.reported.add(code);
    try { diag.warn(code); } catch { /* Diagnostics must not interrupt measurements. */ }
  }
}
