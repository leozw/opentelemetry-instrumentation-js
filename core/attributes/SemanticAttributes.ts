/**
 * Standardized Attributes following strict Semantic Conventions.
 * Includes explicit re-exports from OpenTelemetry and custom extensions.
 */
export const SemanticAttributes = {
  // HTTP
  HTTP: {
    METHOD: 'http.request.method',
    STATUS_CODE: 'http.response.status_code',
    ROUTE: 'http.route',
    URL: 'url.full',
    PATH: 'url.path',
  },

  // Database
  DB: {
    SYSTEM: 'db.system',
    STATEMENT: 'db.statement',
  },

  // RPC
  RPC: {
    SERVICE: 'rpc.service',
    METHOD: 'rpc.method',
    SYSTEM: 'rpc.system',
  },

  // Custom Business Attributes
  CUSTOM: {
    USER_ID: 'user.id', // Should be hashed
    FEATURE_FLAG: 'feature.flag',
    WORKFLOW_NAME: 'workflow.name',
    TENANT_ID: 'tenant.id',
  },
} as const;

export type SemanticAttributeKey = string;
