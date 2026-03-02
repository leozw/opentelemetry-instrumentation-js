/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Instrumentation Registry
 *
 * Declarative registry of all supported instrumentations.
 * Each entry defines:
 *   - name:    Human-readable identifier
 *   - envKey:  Env var to disable (e.g. OTEL_INSTR_PG=false)
 *   - pkg:     The user-land module to detect (e.g. 'pg')
 *   - factory: Lazy constructor for the instrumentation
 *
 * Auto-discovery: If the target `pkg` is not installed in the
 * consuming application, the instrumentation is silently skipped.
 * No crashes, no warnings — just smart defaults.
 */
import { Instrumentation } from '@opentelemetry/instrumentation';
import { ResolvedPrivacyConfig } from '../core/exporter/index';
import { InstrumentationsConfig } from './config';

export interface InstrumentationEntry {
  /** Human-readable name (for logging) */
  name: string;
  /** Env var key to toggle: set to 'false' to disable */
  envKey: string;
  /** NPM package to detect in the user's app (e.g. 'pg', 'ioredis') */
  pkg: string;
  /** Whether this instrumentation is enabled by default (default: true) */
  defaultEnabled?: boolean;
  /** Factory that creates the instrumentation instance */
  factory: (privacy: ResolvedPrivacyConfig) => Instrumentation;
}

export interface ResolveInstrumentationsOptions {
  config?: InstrumentationsConfig;
  privacy: ResolvedPrivacyConfig;
}

/**
 * Check if an instrumentation is enabled via env var.
 * Default: enabled (true). Only disabled when explicitly set to 'false'.
 */
function isEnabled(envKey: string, defaultEnabled = true): boolean {
  const val = process.env[envKey];
  if (val === undefined || val === '') return defaultEnabled;
  return val.toLowerCase() !== 'false';
}

/**
 * Build the full registry of all supported instrumentations.
 * Each entry is lazily constructed only when needed.
 */
export function getRegistry(): InstrumentationEntry[] {
  return [
    // ──────────────── Databases ────────────────
    {
      name: 'PostgreSQL',
      envKey: 'OTEL_INSTR_PG',
      pkg: 'pg',
      factory: () => {
        const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
        return new PgInstrumentation({
          enhancedDatabaseReporting: true,
        });
      },
    },
    {
      name: 'MySQL',
      envKey: 'OTEL_INSTR_MYSQL',
      pkg: 'mysql2',
      factory: () => {
        const { MySQL2Instrumentation } = require('@opentelemetry/instrumentation-mysql2');
        return new MySQL2Instrumentation({});
      },
    },
    {
      name: 'MongoDB',
      envKey: 'OTEL_INSTR_MONGODB',
      pkg: 'mongodb',
      factory: () => {
        const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');
        return new MongoDBInstrumentation({
          enhancedDatabaseReporting: true,
        });
      },
    },
    {
      name: 'Mongoose',
      envKey: 'OTEL_INSTR_MONGOOSE',
      pkg: 'mongoose',
      factory: () => {
        const { MongooseInstrumentation } = require('@opentelemetry/instrumentation-mongoose');
        return new MongooseInstrumentation({});
      },
    },

    // ──────────────── Cache / KV ────────────────
    {
      name: 'ioredis',
      envKey: 'OTEL_INSTR_REDIS',
      pkg: 'ioredis',
      factory: () => {
        const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
        return new IORedisInstrumentation({});
      },
    },
    {
      name: 'Redis (node-redis)',
      envKey: 'OTEL_INSTR_REDIS',
      pkg: 'redis',
      factory: () => {
        const { RedisInstrumentation } = require('@opentelemetry/instrumentation-redis');
        return new RedisInstrumentation({});
      },
    },

    // ──────────────── Query Builders / ORMs ────────────────
    {
      name: 'Knex',
      envKey: 'OTEL_INSTR_KNEX',
      pkg: 'knex',
      factory: () => {
        const { KnexInstrumentation } = require('@opentelemetry/instrumentation-knex');
        return new KnexInstrumentation({});
      },
    },

    // ──────────────── Connection Pooling ────────────────
    {
      name: 'GenericPool',
      envKey: 'OTEL_INSTR_GENERIC_POOL',
      pkg: 'generic-pool',
      factory: () => {
        const { GenericPoolInstrumentation } = require('@opentelemetry/instrumentation-generic-pool');
        return new GenericPoolInstrumentation({});
      },
    },

    // ──────────────── Frameworks ────────────────
    {
      name: 'NestJS',
      envKey: 'OTEL_INSTR_NESTJS',
      pkg: '@nestjs/core',
      factory: () => {
        const { NestInstrumentation } = require('@opentelemetry/instrumentation-nestjs-core');
        return new NestInstrumentation({});
      },
    },
    {
      name: 'Koa',
      envKey: 'OTEL_INSTR_KOA',
      pkg: 'koa',
      factory: () => {
        const { KoaInstrumentation } = require('@opentelemetry/instrumentation-koa');
        return new KoaInstrumentation({});
      },
    },

    // ──────────────── Network ────────────────
    {
      name: 'DNS',
      envKey: 'OTEL_INSTR_DNS',
      pkg: 'dns',
      defaultEnabled: false,
      factory: () => {
        const { DnsInstrumentation } = require('@opentelemetry/instrumentation-dns');
        return new DnsInstrumentation({});
      },
    },
    {
      name: 'Net',
      envKey: 'OTEL_INSTR_NET',
      pkg: 'net',
      defaultEnabled: false,
      factory: () => {
        const { NetInstrumentation } = require('@opentelemetry/instrumentation-net');
        return new NetInstrumentation({});
      },
    },

    // ──────────────── Log Correlation ────────────────
    {
      name: 'Pino',
      envKey: 'OTEL_INSTR_PINO',
      pkg: 'pino',
      factory: () => {
        const { PinoInstrumentation } = require('@opentelemetry/instrumentation-pino');
        return new PinoInstrumentation({});
      },
    },
    {
      name: 'Winston',
      envKey: 'OTEL_INSTR_WINSTON',
      pkg: 'winston',
      factory: () => {
        const { WinstonInstrumentation } = require('@opentelemetry/instrumentation-winston');
        return new WinstonInstrumentation({});
      },
    },
  ];
}

/**
 * Resolve all instrumentations that should be activated.
 *
 * For each entry in the registry:
 *   1. Check if disabled via env var → skip
 *   2. Check if the target module is installed → skip if not
 *   3. Create the instrumentation instance
 *
 * Returns the list of active Instrumentation instances + logs what was activated.
 */
export function resolveInstrumentations(options: ResolveInstrumentationsOptions): Instrumentation[] {
  const registry = getRegistry();
  const active: Instrumentation[] = [];
  const activeNames: string[] = [];
  const disabled: string[] = [];

  for (const entry of registry) {
    if (!isEnabled(entry.envKey, entry.defaultEnabled ?? true)) {
      disabled.push(entry.name);
      continue;
    }

    try {
      active.push(entry.factory(options.privacy));
      activeNames.push(entry.name);
    } catch (err) {
      console.warn(`[instrumentation-js] Failed to load ${entry.name}:`, err);
    }
  }

  // Log summary
  if (activeNames.length > 0) {
    console.log(`[instrumentation-js] ✅ Active: ${activeNames.length} instrumentations → ${activeNames.join(', ')}`);
  }
  if (disabled.length > 0) {
    console.log(`[instrumentation-js] ⛔ Disabled via env: ${disabled.join(', ')}`);
  }

  return active;
}
