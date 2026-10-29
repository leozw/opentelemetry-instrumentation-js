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

Seventeen native Node tests, lint, typecheck and build passed. Clean packed CJS,
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

Development npm audit still flags esbuild and uuid through the benchmark
toolchain. The Windows esbuild dev server and uuid v3/v5/v6 buffer APIs are not
used by this build/benchmark path, but the findings are not called scanner-green.
gRPC, real database drivers, long soak, Windows/Linux native packaging and a
full in-process SDK restart after shutdown remain unqualified.

Full private evidence is in the coordinating audit's `evidence/node/report.json`
and `report.md`, with exact artifacts, hashes, source lines, advisories and gaps.
The published registry identities have not been changed.

Primary references:
- https://github.com/open-telemetry/opentelemetry-js/releases/tag/v2.12.0
- https://github.com/open-telemetry/opentelemetry-js/releases/tag/v3.0.0
- https://github.com/open-telemetry/opentelemetry-js-contrib/security/advisories/GHSA-qqmp-wf37-98f9
- https://nodejs.org/en/about/previous-releases
