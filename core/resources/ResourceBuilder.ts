import { Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as os from 'os';
import { Attributes } from '@opentelemetry/api';
import { DataBudget, ownedString } from '../memory/OwnedData';
import { snapshotConfig } from '../memory/ConfigSnapshot';
import { AttributePrivacy, ResolvedPrivacyConfig } from '../exporter/RedactingSpanExporter';

// Explicitly define to avoid circular dependency import issues for now, or match api/types.ts
export interface ResourceConfig {
  serviceName: string;
  serviceVersion: string;
  serviceNamespace?: string;
  deploymentEnvironment?: string;
  attributes?: Attributes;
}

export class ResourceBuilder {
  private _config: ResourceConfig;
  private readonly privacy: AttributePrivacy;

  constructor(config: ResourceConfig, privacy: ResolvedPrivacyConfig = { redactDbStatement: true, hashUserId: true, allowRawAttributes: [] }) {
    config = snapshotConfig(config);
    this.privacy = new AttributePrivacy(privacy);
    this._config = {
      serviceName: ownedString(config.serviceName, 255),
      serviceVersion: ownedString(config.serviceVersion, 255),
      ...(config.serviceNamespace !== undefined ? { serviceNamespace: ownedString(config.serviceNamespace, 255) } : {}),
      ...(config.deploymentEnvironment !== undefined ? { deploymentEnvironment: ownedString(config.deploymentEnvironment, 255) } : {}),
      ...(config.attributes ? { attributes: new DataBudget().attributes(config.attributes) } : {}),
    };
  }

  public detect(): Resource {
    const attributes: Attributes = {
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

    return resourceFromAttributes(this.privacy.sanitize(attributes));
  }

  public getDetectors() {
    return [];
  }
}
