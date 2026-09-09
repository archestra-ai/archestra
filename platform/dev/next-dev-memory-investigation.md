# Local Next.js development memory investigation

Measured September 9, 2026 on macOS 26.7 arm64, Node 24.19.0.
Branch: `investigate/next-dev-memory`, based on main at `dc71329d0`.

## Finding

Repeated invalidation and rendering of the same page reproduces sustained
post-GC JavaScript heap growth on Next 16.3.3 with Webpack. After warm-up,
roughly 44 MB stays live per cycle. Fifty cycles grew the post-GC heap from
1.60 GB to 3.88 GB. Repeating requests without invalidation did not show
comparable growth.

This is strong evidence of a development reload retention problem. It does
not establish the exact retaining reference, prove growth continues forever,
or attribute the entire footprint of older servers to this mechanism.
The original largest server was stopped before heap inspection, as requested.

Next's default heap sizing amplifies the impact: each `next dev` server gets
half the machine's physical RAM as its old-space budget unless explicitly
configured. On this 64 GiB machine that means `--max-old-space-size=32768`
**for each worktree**, without accounting for other running servers.

## Existing-process evidence

- The largest server had a 32 GiB macOS physical footprint. Its verified
  detached pnpm launcher, dev wrapper, Next launcher, and Next server were
  terminated; all five processes exited. System physical use fell from
  61 GiB to 45 GiB immediately afterward.
- Two other Webpack servers had 11.2 and 12.3 GiB footprints. Both had only
  about 0.16–0.22 GiB of dirty/swapped IOAccelerator allocations. That category
  does not explain their multi-GB footprints. Reserved virtual address space
  is not physical usage.
- On the 11.2 GiB server, inspector measurements showed 5.66 GB heap used,
  2.78 GB ArrayBuffers, and a 34.56 GB total heap limit. Its effective
  NODE_OPTIONS included `--max-old-space-size=32768 --enable-source-maps`.
- An inspector-requested full GC reduced heap use to 4.84 GB, but did not
  reclaim the 2.78 GB of ArrayBuffers. A buffer-size census counted about
  15,600 buffers, including three 100 MiB buffers. Buffer sizes alone do not
  identify their owners.
- The temporary inspector listener on that existing server was closed after
  inspection. Other sessions' servers were preserved.

macOS `top`/`vmmap` physical footprint is essential here: compressed/swapped
pages made `ps` RSS substantially understate the processes' memory cost.
Inspector figures below use decimal GB; macOS footprint figures use its
binary-scaled display. ArrayBuffers are included in external memory, so do
not add both together.

## Isolated reproduction

A fresh main worktree used its frozen lockfile and an offline pnpm install.
One frontend-only Tilt resource launched the real dev wrapper on port 3098:

```sh
ARCHESTRA_DEV_BUNDLER=webpack NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @frontend dev --port 3098
```

A temporary Node preload recorded aggregate memory figures every five seconds.
The actual Next server's heap limit was 6.64 GB, confirming that Next respected
the explicit budget. No backend or database was started for this experiment.

The test requested `/auth/sign-in` and consumed each entire response. Every
request returned HTTP 200. Measurements used `HeapProfiler.collectGarbage`
followed by `Runtime.evaluate` of `process.memoryUsage()` through the local
Node inspector.

| Stage | Post-GC heap, GB | ArrayBuffers, GB |
| --- | ---: | ---: |
| Initial compiled page | 1.555 | 0.913 |
| 30 more requests, no source invalidation | 1.595 | 0.918 |
| 10 invalidation/request cycles | 2.072 | 1.240 |
| 20 cycles | 2.514 | 1.245 |
| 30 cycles | 2.958 | 1.250 |
| 40 cycles | 3.400 | 1.255 |
| 50 cycles | 3.882 | 1.261 |

Each cycle updated the modification time of `frontend/src/app/layout.tsx`
without changing its contents, waited 700 ms, then requested the same page.
Thus the route set and source content stayed constant. Measurements followed
each batch of ten cycles. This exercises server recompilation and reload;
it does not simulate a browser HMR WebSocket session or authenticated browsing.

A sampling heap profile during cycles 41–50, collected after GC, showed live
allocations in module source loading, Webpack module graph/cache handling,
Node source-map parsing, and re-evaluated shared schema modules in both SSR
and RSC bundles. Shared module initialization is a substantial contributor;
a sampling allocation stack does not identify the root that retains it.
No full heap snapshot was taken on the already memory-constrained machine.

## Source inspection and upstream context

In the installed Next 16.3.3 package:

- `dist/cli/next-dev.js` sets old-space to `floor(totalmemMiB * 0.5)` when no
  explicit old-space setting or `NEXT_DISABLE_MEM_OVERRIDE` is supplied.
- `dist/server/lib/utils.js:getMemoryRestartStats` triggers a dev restart only
  when used JS heap exceeds 80% of the heap limit. The request listener calls
  this after handling requests. It does not measure physical footprint or
  external buffers. With the default budget, this guard acts far too late
  for several concurrent worktrees.
- Webpack filesystem cache already uses `maxMemoryGenerations: 0` in dev,
  with Next's separate memory cache plugin. Setting that same value again
  would not constitute a fix.
- The project wrapper starts one Next launcher, and Next forwards termination
  to its server child. Multiple worktree servers are real independent stacks;
  their existence alone does not establish a teardown bug.
- `dev/Tiltfile.dev` explicitly defaults `ARCHESTRA_DEV_BUNDLER` to Turbopack,
  overriding `frontend/scripts/dev.mjs`'s macOS arm64 Webpack fallback.
  Custom preview Tiltfiles can behave differently.

[Next issue #94696](https://github.com/vercel/next.js/issues/94696) reports a
similar post-GC HMR module-retention pattern on 16.2.x with both bundlers.
It was automatically closed for reproduction-link validation, not resolved
by a confirmed fix. The resemblance is evidence for further investigation,
not proof that our retaining reference is identical.

The [native-allocation report referenced by our launcher](https://github.com/vercel/next.js/issues/92055)
is not a sufficient explanation for the inspected Webpack processes.
[Next's memory guide](https://nextjs.org/docs/app/guides/memory-usage) describes
compiler-cache and source-map tradeoffs, but those options have not been
validated as fixes for this reproduction.

## Recommended next changes

1. Give every dev launch path a bounded default heap budget while preserving
   explicit developer NODE_OPTIONS. The 6 GiB old-space setting handled this
   narrow test; it still needs authenticated page coverage before becoming
   a project-wide default. A heap budget mitigates damage, not the retention
   bug, and does not cap total process memory.
2. Compare the same reload workload with server source maps disabled, then
   with narrower shared-module imports. Measure post-GC growth per cycle,
   rather than just startup RSS, before choosing an optimization.
3. Use a small reproduction or paired heap snapshots on a machine with spare
   memory to locate the exact retaining root. Compare bundlers sequentially
   before claiming Turbopack is a fix.
4. Keep preview concurrency within the machine's memory capacity and stop
   completed stacks through their owning supervisors.

No runtime code or dependency versions were changed. Automated regression
tests were not added because this is an investigation artifact; the real
server experiment above supplies the behavioral evidence. Existing public
pages under `docs/pages` were audited: this dev-only finding does not change
product or deployment behavior, so no public documentation change is needed.
Temporary logs and the sampling profile remain outside Git. The isolated
Tilt stack is stopped after measurement.
