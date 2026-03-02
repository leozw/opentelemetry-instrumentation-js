export const INSTRUMENTATION_NAMES = [
  'http',
  'express',
  'fastify',
  'graphql',
  'pg',
  'mysql',
  'mongodb',
  'mongoose',
  'redis',
  'knex',
  'genericPool',
  'nestjs',
  'koa',
  'dns',
  'net',
  'pino',
  'winston',
] as const;

export type InstrumentationName = typeof INSTRUMENTATION_NAMES[number];

export interface InstrumentationToggleConfig {
  enabled?: boolean;
}

export type InstrumentationsConfig = Partial<Record<InstrumentationName, InstrumentationToggleConfig>>;

export const INSTRUMENTATION_ENV_KEYS: Record<InstrumentationName, string> = {
  http: 'OTEL_INSTR_HTTP',
  express: 'OTEL_INSTR_EXPRESS',
  fastify: 'OTEL_INSTR_FASTIFY',
  graphql: 'OTEL_INSTR_GRAPHQL',
  pg: 'OTEL_INSTR_PG',
  mysql: 'OTEL_INSTR_MYSQL',
  mongodb: 'OTEL_INSTR_MONGODB',
  mongoose: 'OTEL_INSTR_MONGOOSE',
  redis: 'OTEL_INSTR_REDIS',
  knex: 'OTEL_INSTR_KNEX',
  genericPool: 'OTEL_INSTR_GENERIC_POOL',
  nestjs: 'OTEL_INSTR_NESTJS',
  koa: 'OTEL_INSTR_KOA',
  dns: 'OTEL_INSTR_DNS',
  net: 'OTEL_INSTR_NET',
  pino: 'OTEL_INSTR_PINO',
  winston: 'OTEL_INSTR_WINSTON',
};

export const INSTRUMENTATION_DEFAULTS: Record<InstrumentationName, boolean> = {
  http: true,
  express: true,
  fastify: true,
  graphql: true,
  pg: true,
  mysql: true,
  mongodb: true,
  mongoose: true,
  redis: true,
  knex: true,
  genericPool: true,
  nestjs: true,
  koa: true,
  dns: false,
  net: false,
  pino: true,
  winston: true,
};

function parseBooleanEnv(rawValue: string | undefined): boolean | undefined {
  if (rawValue === undefined) return undefined;
  const value = rawValue.trim().toLowerCase();
  if (value === '') return undefined;
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  return undefined;
}

export function resolveEnabled(
  explicit: boolean | undefined,
  envKey: string,
  defaultEnabled: boolean
): boolean {
  if (explicit !== undefined) return explicit;
  const envValue = parseBooleanEnv(process.env[envKey]);
  if (envValue !== undefined) return envValue;
  return defaultEnabled;
}
