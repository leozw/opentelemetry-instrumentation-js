import {
  Attributes,
  Counter,
  Histogram,
  Meter,
  metrics,
  ObservableGauge,
  UpDownCounter,
} from '@opentelemetry/api';

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

  constructor(name: string, version?: string) {
    this._meter = metrics.getMeter(name, version);
  }

  public getCounter(name: string, description?: string): Counter {
    if (!this._counters.has(name)) {
      this._counters.set(name, this._meter.createCounter(name, description ? { description } : undefined));
    }
    const counter = this._counters.get(name);
    if (!counter) throw new Error(`Failed to create counter ${name}`);
    return counter;
  }

  public getHistogram(name: string, description?: string): Histogram {
    if (!this._histograms.has(name)) {
      this._histograms.set(name, this._meter.createHistogram(name, description ? { description } : undefined));
    }
    const histogram = this._histograms.get(name);
    if (!histogram) throw new Error(`Failed to create histogram ${name}`);
    return histogram;
  }

  public getUpDownCounter(name: string, description?: string): UpDownCounter {
    if (!this._upDownCounters.has(name)) {
      this._upDownCounters.set(name, this._meter.createUpDownCounter(name, description ? { description } : undefined));
    }
    const counter = this._upDownCounters.get(name);
    if (!counter) throw new Error(`Failed to create UpDownCounter ${name}`);
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
}
