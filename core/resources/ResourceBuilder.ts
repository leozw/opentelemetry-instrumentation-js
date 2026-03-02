import { Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as os from 'os';

// Explicitly define to avoid circular dependency import issues for now, or match api/types.ts
export interface ResourceConfig {
  serviceName: string;
  serviceVersion: string;
  serviceNamespace?: string;
  deploymentEnvironment?: string;
  attributes?: Record<string, string | number | boolean>;
}

export class ResourceBuilder {
  private _config: ResourceConfig;

  constructor(config: ResourceConfig) {
    this._config = config;
  }

  public detect(): Resource {
    const attributes: Record<string, string | number | boolean> = {
      [SemanticResourceAttributes.SERVICE_NAME]: this._config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: this._config.serviceVersion,
      'host.name': os.hostname(),
      [SemanticResourceAttributes.PROCESS_PID]: process.pid,
      [SemanticResourceAttributes.PROCESS_RUNTIME_NAME]: 'nodejs',
      [SemanticResourceAttributes.PROCESS_RUNTIME_VERSION]: process.version,
    };

    if (this._config.deploymentEnvironment) {
      attributes['deployment.environment'] = this._config.deploymentEnvironment;
    }

    if (this._config.serviceNamespace) {
      attributes['service.namespace'] = this._config.serviceNamespace;
    }

    // Add extra attributes
    if (this._config.attributes) {
      Object.assign(attributes, this._config.attributes);
    }

    return resourceFromAttributes(attributes);
  }

  public getDetectors() {
    return [];
  }
}
