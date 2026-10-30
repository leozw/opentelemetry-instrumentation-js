import { diag } from '@opentelemetry/api';

export interface MatcherCall { readonly failed: boolean; close(): void }
interface CorePolicy {
  begin(): MatcherCall;
  testRule(role: 'selectors', index: number, text: string, call: MatcherCall): boolean;
  close(): void;
  toJSON(): { ready: boolean; codes: string[] };
}
// Byte-identical to the immutable logger 5bab9d0 policy; no logger dependency.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./matcher-core.cjs') as {
  Policy: new (config: { selectors: RegExp[]; onDiagnostic: (code: string) => void }) => CorePolicy;
};

export class MatcherPolicy {
  private readonly policy: CorePolicy;
  constructor(patterns: RegExp[]) {
    this.policy = new core.Policy({ selectors: patterns, onDiagnostic: code => { diag.warn(code); } });
    const state = this.policy.toJSON();
    if (!state.ready) {
      this.policy.close();
      throw new Error(state.codes[0] ?? 'ELVEN_MATCHER_BACKEND_FAILURE');
    }
  }
  begin(): MatcherCall { return this.policy.begin(); }
  match(index: number, value: string, call: MatcherCall): boolean { return this.policy.testRule('selectors', index, value, call); }
  close(): void { this.policy.close(); }
}
