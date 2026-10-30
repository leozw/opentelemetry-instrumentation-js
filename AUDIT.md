# Node SDK Audit Candidate 1.0.9

Review candidate only. No merge, npm publication, deployment or credential change
was performed. The npm package identity and the 1.0.8 public API are retained.

## Changes

- OTel 2.12.x / 0.223.x with auto-instrumentations 0.81.x, without force overrides
  or a downgrade to avoid GHSA-qqmp-wf37-98f9.
- Additive `failOpen?: boolean`, default false: startup failures reject; true
  returns an explicitly unstarted no-op handle. Network reachability is not a
  synchronous startup guarantee. Wrapper callers should own lifecycle with
  `autoShutdown: false`; no private API is required.
- Shared CJS/ESM initialization, stale-handle fencing, removable signal handlers,
  Worker preload gate, and no library-owned `process.exit(0)`.
- Span/event/link redaction without source mutation, URL credential/query
  redaction, finite span payload limits and finite metric instrument names.
- Bounded HTTP request deadlines/agent cleanup and upstream context-manager
  listener handling, including prepend/once/remove variants.
- Committed lockfile and Node 22/24/26 CI matrix. Node 18/20 compatibility is not
  upstream security support; the production engine floor follows OTel 2.x.

## Verification

Fifty-five native Node tests, lint, typecheck and build passed. Clean packed CJS,
ESM and preload consumers exported actual OTLP protobuf on Node 18/20/22/24/26.
A strict packed TypeScript consumer accepts `failOpen: false`, the public handle,
and both facades without casts. The clean production graph has zero npm
advisories at the audit timestamp. HTTP offline/429/trickle/large-response and
recursive exporter cases were exercised locally.

## Release Blockers

The corrected benchmark uses actual trace/metric export and p99, rather than a
disabled preload and an unavailable p95 field. The final local gate exceeded
the existing 3% threshold. It remains enforced, not waived. The published 1.0.8
also showed substantial cost in this deliberately minimal HTTP profile, so this
does not establish a patch regression or universal overhead. Performance release
acceptance needs an isolated, representative workload and explicit review.

The development build now uses tsup 9 / esbuild 0.28.2 to remediate the esbuild
advisory; builds require maintained Node 22.18+, 24.11+ or 26+, while emitted
package code still targets Node 18.19. Development npm audit still flags uuid
through autocannon/hyperid. Their declared ranges have no compatible fix;
uuid v3/v5/v6 buffer APIs are not used by this benchmark. No force override or
autocannon downgrade was accepted, and development is not called scanner-green.
gRPC, real database drivers, long soak, Windows/Linux native packaging and a
full foreign-framework restart after shutdown remain unqualified.

Full private evidence is in the coordinating audit's `evidence/node/report.json`
and `report.md`, with exact artifacts, hashes, source lines, advisories and gaps.
The published registry identities have not been changed.

Manual release/provenance policy is tested separately. The main-only workflow
requires exact-SHA successful main CI, public repository metadata, a clean
production graph and an archive receipt. NPM_TOKEN appears only in the publish
step. The workflow has not been dispatched, and the performance gate remains a
publication blocker. Original and corrected harness receipts plus CPU profiles
are retained by hosted CI, including when the gate fails.

Hosted run 40930484098 on ba55622 reproduced the failure on Node 22/24/26:
audited active harness candidate p99 deltas were 266.67%, 233.33%, 300%; revised
collector-isolated harness deltas were 233.33%, 200%, 266.67%. Published 1.0.8
also failed both active harnesses. Quantization/order/collector coupling are real
measurement limitations, but do not explain away the remaining cost. Against
the immutable audited reference, observed candidate throughput improved
10.90%, 9.52%, 2.92% and CPU/request decreased 13.21%, 10.45%, 3.87% in that
run. These are observations on shared hosted runners, not universal guarantees.

A follow-up test also prevents unselected upstream instrumentation instances
from retaining constructor-enabled hooks after they are filtered out. Selected
HTTP/database/framework coverage and privacy remain enabled as configured.

The published 1.0.8 README explicitly promises p95 <3%. Its historical main
harness disabled trace/metric export and read an absent p95 field as zero,
falling back to throughput. That was not proof of the published p95 promise.
The audit retains the enforced 3% p99 check and also measures/enforces the
documented p95 from public autocannon response events using native microsecond
HDR samples; missing samples fail closed. No feature, privacy setting or gate
was removed. Historical inactive, audited active and revised harnesses are
separate receipts. Measurements do not establish physical impossibility for
every workload; this synthetic capacity profile remains a release blocker.

Signal regressions also cover application once/prependOnce handlers, normal
signal exit status, removed-earlier handlers and observer cleanup. An observer
remembers once-handler removal only until the next microtask, without retaining
application functions or mistaking it for permission to re-signal the process.

Run 40940552957 at fd41733 independently captured real p95. Candidate versus
bare median paired deltas on Node 22/24/26 were 309.45%, 344.91%, 335.25%;
public 1.0.8 was 320.92%, 335.03%, 373.64%. The literal unmodified historical
main harness passed public 1.0.8 on all three runtimes with exporters disabled
and absent p95 coerced to zero. This distinguishes an invalid historical
qualification from the substantial active-capture cost, not physical
impossibility for every workload. No human has accepted a budget/profile
change. Release remains blocked.

Profiles after the constructor-hook fix are dominated by upstream HTTP and
context stacks, including native I/O; those inclusive percentages overlap.
Named privacy functions account for about 1% of active samples, not the whole
overhead. A further copy-on-write change retains clean event/link arrays and
clones only changed items, avoiding two arrays and two verification scans per
clean span without dropping any redaction. A synthetic exporter-only receipt
cannot establish the HTTP gate or a universal overhead guarantee. More small
privacy-loop changes are not evidence of a credible path from hundreds of
percent to 3%; retaining the universal minimal-HTTP budget requires a separately
qualified instrumentation/context architecture. An alternate representative
profile requires an explicit human contract decision, not a silent waiver.

Primary references:
- https://github.com/open-telemetry/opentelemetry-js/releases/tag/v2.12.0
- https://github.com/open-telemetry/opentelemetry-js/releases/tag/v3.0.0
- https://github.com/open-telemetry/opentelemetry-js-contrib/security/advisories/GHSA-qqmp-wf37-98f9
- https://nodejs.org/en/about/previous-releases

Independent review confirmed a P1: shutdown left closed global providers
registered, so reinitialization reported healthy but exported nothing. Runtime
cleanup now unregisters only still-current trace/metric identities it actually
registered. Occupied requested providers reject startup or return explicitly
unstarted fail-open; foreign and later replacement providers are preserved.
Reusing a bounded instrumentation pool also restores HTTP hooks after restart,
avoiding fresh instances that cannot repatch upstream's cached core modules.
Four alternating CJS/ESM generations now export decoded traces and counters to
two selected destinations, retain actual HTTP/context propagation and reject
cross-destination/stale-handle interference. The regression failed before the
fix; synthetic isStarted-only lifecycle tests were insufficient.

Ambient OTLP header merging is upstream behavior and documented in README.
An explicit URL does not clear unrelated ambient credentials. This SDK does
not mutate shared environment variables or claim independent-destination
credential ownership; a wrapper selecting that policy must guard it explicitly.
The strict 3% performance gate remains unchanged and blocks release.

PARENT-SDK09 independently identified a regression in the restart ownership
check: upstream intentionally registers no providers with OTEL_SDK_DISABLED,
but strict startup treated that as a collision. The public initializer now uses
upstream getBooleanFromEnv before active pipeline construction. Intentional
disable returns an initialized no-op handle for strict, fail-open and default
callers; its facades do not borrow foreign providers. Required registration
checks remain unchanged for active startup. Direct, CJS/ESM, mixed-case/trimmed
true, false/non-true conflict controls and zero-code preload are covered.

Performance qualification remains on HOLD. The full active benchmark receipts
apply to 6fe67ef / archive87afd7ef, not this disable-only successor. Functional
CI and archived consumers are rerun for the new source; no benchmark result is
transferred as a fresh pass and the source 3% gate is not changed or waived.
