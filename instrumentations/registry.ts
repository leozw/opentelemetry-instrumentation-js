import { ResolvedPrivacyConfig } from '../core/exporter/index';
import { INSTRUMENTATION_DEFAULTS, INSTRUMENTATION_ENV_KEYS, INSTRUMENTATION_NAMES, InstrumentationsConfig, resolveEnabled } from './config';

export interface ResolveInstrumentationsOptions {
  config?: InstrumentationsConfig;
  privacy: ResolvedPrivacyConfig;
}

// Map our internal names to the actual package names used by auto-instrumentations-node
const PACKAGE_NAME_MAP: Record<string, string> = {
  http: '@opentelemetry/instrumentation-http',
  express: '@opentelemetry/instrumentation-express',
  fastify: '@opentelemetry/instrumentation-fastify',
  graphql: '@opentelemetry/instrumentation-graphql',
  pg: '@opentelemetry/instrumentation-pg',
  mysql: '@opentelemetry/instrumentation-mysql2',
  mongodb: '@opentelemetry/instrumentation-mongodb',
  mongoose: '@opentelemetry/instrumentation-mongoose',
  redis: '@opentelemetry/instrumentation-redis', // Covers both redis and ioredis in auto-instrumentations
  knex: '@opentelemetry/instrumentation-knex',
  genericPool: '@opentelemetry/instrumentation-generic-pool',
  nestjs: '@opentelemetry/instrumentation-nestjs-core',
  koa: '@opentelemetry/instrumentation-koa',
  dns: '@opentelemetry/instrumentation-dns',
  net: '@opentelemetry/instrumentation-net',
  pino: '@opentelemetry/instrumentation-pino',
  winston: '@opentelemetry/instrumentation-winston',
};

// Auto-instrumentations-node includes many noisy packages by default that we didn't use before.
// We explicitly disable them unless the user turns them on.
const EXPLICITLY_DISABLED_BY_DEFAULT = [
  '@opentelemetry/instrumentation-fs',
  '@opentelemetry/instrumentation-grpc',
  '@opentelemetry/instrumentation-amqplib',
  '@opentelemetry/instrumentation-aws-sdk',
  '@opentelemetry/instrumentation-bunyan',
  '@opentelemetry/instrumentation-cassandra-driver',
  '@opentelemetry/instrumentation-connect',
  '@opentelemetry/instrumentation-cucumber',
  '@opentelemetry/instrumentation-dataloader',
  '@opentelemetry/instrumentation-hapi',
  '@opentelemetry/instrumentation-memcached',
  '@opentelemetry/instrumentation-restify',
  '@opentelemetry/instrumentation-router',
  '@opentelemetry/instrumentation-socket.io',
  '@opentelemetry/instrumentation-tedious',
  '@opentelemetry/instrumentation-grpc',
];

/**
 * Builds the configuration object for @opentelemetry/auto-instrumentations-node
 * based on our custom env vars and config.
 */
export function getAutoInstrumentationsConfig(options: ResolveInstrumentationsOptions): Record<string, unknown> {
  const configObj: Record<string, unknown> = {};

  // 1. Disable all the noisy things we don't want by default
  for (const pkg of EXPLICITLY_DISABLED_BY_DEFAULT) {
    configObj[pkg] = { enabled: false };
  }

  // 2. Map our known instrumentations
  for (const name of INSTRUMENTATION_NAMES) {
    const pkgName = PACKAGE_NAME_MAP[name];
    if (!pkgName) continue;

    const isEnabled = resolveEnabled(
      options.config?.[name]?.enabled,
      INSTRUMENTATION_ENV_KEYS[name],
      INSTRUMENTATION_DEFAULTS[name]
    );

    const pkgConfig: Record<string, unknown> = { enabled: isEnabled };

    // Inject our specific custom configs for databases
    if (isEnabled) {
      if (name === 'pg' || name === 'mongodb' || name === 'mysql') {
        pkgConfig.enhancedDatabaseReporting = true;
      }
      if (name === 'graphql') {
        pkgConfig.mergeItems = true;
        pkgConfig.allowValues = false;
      }
    }

    configObj[pkgName] = pkgConfig;
  }

  // ioredis is a special case. the old config mapped 'redis' to BOTH.
  // We'll explicitly map ioredis to the same toggle as redis.
  const redisEnabled = resolveEnabled(
    options.config?.redis?.enabled,
    INSTRUMENTATION_ENV_KEYS['redis'],
    INSTRUMENTATION_DEFAULTS['redis']
  );
  configObj['@opentelemetry/instrumentation-ioredis'] = { enabled: redisEnabled };

  return configObj;
}

