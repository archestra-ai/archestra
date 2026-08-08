# Dagger-backed MCP hibernation prototype

Status: design spike; native lifecycle primitives exist, but nothing registers
this runtime with `McpServerRuntimeManager`.

## Result

Dagger can materially simplify idle hibernation for a narrow class of MCP
servers: single-tenant, `streamable-http`, container-native catalog entries
that do not depend on custom Kubernetes YAML or Kubernetes-specific identity,
secret, networking, or ingress features.

For that lane, an MCP server becomes a Dagger `Container.asService()` behind a
host tunnel:

```text
first demand -> construct content-addressed container graph
             -> start tunnel (starts service + waits for port health)
             -> return host-local HTTP endpoint

idle sweep   -> stop tunnel + service

next demand  -> evaluate the same graph
             -> reuse engine image/layer cache
             -> start a new service and tunnel
```

This replaces the Kubernetes mechanics in PR #7135 for eligible servers:

- no replica-count annotation to remember;
- no `resourceVersion` compare-and-swap around replica patches;
- no separate `waking` annotation cleanup;
- no pod/Deployment readiness polling in the Node process;
- no per-server Kubernetes Service;
- no explicit image-cache inspection (the Dagger engine owns its cache);
- no stale pod/session cleanup after hibernation.

It does **not** replace the hard part of the feature: deciding that a workload
is idle without racing live demand. The persisted `last_used_at`, active-use
tracking, organization/install policy, single-flight demand path, and an
eventual distributed demand lease remain useful regardless of workload runtime.

## Prototype code

The existing `@archestra/sandbox-rs` Dagger session now exposes two deliberately
named experimental operations:

- `startDaggerMcpServicePrototype`: builds an image/env/command graph, starts a
  Dagger service through a random-port host tunnel, and returns its HTTP URL;
- `stopDaggerMcpServicePrototype`: stops the tunnel and source service, with an
  idempotent `stopped: false` result when this session does not own it.

The native per-target service map gives concurrent starts in one backend
process a per-physical-service single-flight property while allowing different
servers to wake concurrently. Supplying the same service key/spec reuses the
endpoint; supplying a changed spec stops the old graph before starting the
replacement. Secret env values use Dagger `Secret` nodes rather than plain
graph arguments. The reserved `ARCHESTRA_MCP_SERVICE_KEY` graph input prevents
Dagger from de-duplicating two distinct logical workloads that happen to have
identical image/env/command configuration.

`dagger-mcp-service-prototype.ts` is the TypeScript boundary. Its admission gate
refuses lossy translations and its builder converts an admitted catalog plus
already-resolved install env values into the native spec. It is intentionally
unregistered, so merely shipping the spike cannot move an existing MCP server.

## Why this cannot replace the Kubernetes runtime yet

| Capability | Dagger spike | Existing Kubernetes runtime |
| --- | --- | --- |
| HTTP container start/stop | Native service lifecycle | Deployment replicas |
| Cold-start cache | Dagger/BuildKit graph and image cache | Node image cache + pull policy |
| HTTP reachability | Client-session host tunnel | Stable Service/pod address |
| `stdio` MCP | Not modeled | Kubernetes exec/WebSocket |
| Custom deployment YAML | Not representable safely | First-class |
| `envFrom`, mounted secrets, ServiceAccount | Not modeled | First-class |
| Image pull secrets | Not modeled by this primitive | First-class |
| NodePort/ingress/stable callback address | Not modeled | First-class |
| Multiple backend replicas | Source service is content-addressed/de-duplicated, but tunnels and Archestra state are session-local | Kubernetes object is shared truth |
| Backend restart adoption | Session and tunnel are gone; demand restarts | Deployment annotations are adopted |
| Scheduler/autoscaler visibility | Engine is the scheduled unit | Every MCP pod is visible |

Two constraints are architectural rather than missing fields:

1. Dagger de-duplicates the same content-addressed service requested by multiple
   clients and keeps it alive while referenced, but each host tunnel and its URL
   are client-session-local. That is not stable cluster service discovery or a
   durable Archestra state record.
2. The current per-environment Dagger engine is one privileged, scheduler-
   opaque capacity envelope. Moving hundreds of MCP processes into it makes
   Kubernetes see engine capacity rather than individual MCP requests/limits.

Those trade per-server Kubernetes overhead for a denser shared runtime, but
they also weaken scheduling isolation and make a single engine a larger failure
domain. That should be an explicit product/runtime choice, not an incidental
hibernation refactor.

## Recommended production seam

First separate hibernation policy from workload mechanics. The policy module
should depend on a small runtime contract rather than `K8sDeployment`:

```ts
interface McpWorkloadRuntime {
  key(serverId: string): Promise<string>;
  observe(serverId: string): Promise<"stopped" | "starting" | "ready" | "failed">;
  ensureServing(serverId: string): Promise<{ endpoint: string }>;
  stopIfOwned(serverId: string): Promise<boolean>;
  hardReset(serverId: string): Promise<void>;
}
```

Then keep two implementations:

- `KubernetesMcpWorkloadRuntime`: wraps today's `K8sDeployment`, preserving the
  full catalog surface and external-scaler compatibility;
- `DaggerMcpWorkloadRuntime`: wraps the native prototype for admitted HTTP
  catalogs only.

The idle-policy flow remains shared:

```text
policy/licence gates
  -> sibling-group demand lease + fresh last-used check
  -> runtime.stopIfOwned()
  -> invalidate MCP client/session pools
  -> compensate with runtime.ensureServing() if demand crossed the stop
```

The latest PR wake contract also stays shared: the MCP client waits only
`wakeResponseBudgetMs()` for `ensureServing()`, then returns the existing
retryable “still starting” tool result while the runtime single-flight continues
in the background. A faster Dagger cold start is an optimization, not a reason
to hold a caller beyond its response budget.

Before production wiring, turn Dagger's reference lifetime into an explicit
Archestra lease model. Every active tool call should hold a short-lived service
reference/tunnel; an idle-window keeper holds the warm reference. Hibernation
drops only the keeper. Dagger then keeps the de-duplicated source service alive
until active references from every backend replica are gone, directly closing
the current stop-vs-demand race for the Dagger lane. Persisted ownership/state
is still needed for observability, restart convergence, and endpoint routing;
the engine reference count must not be treated as queryable durable state.

## Suggested experiment

1. Run only on a single backend replica and behind a separate prototype flag.
2. Admit explicit-image, single-tenant streamable-HTTP catalogs through the
   compatibility gate; everything else stays on Kubernetes.
3. Route only the MCP client's HTTP endpoint lookup through the Dagger adapter.
4. Measure warm call latency, cold wake latency, engine RSS, per-service RSS,
   concurrent wake behavior, image-registry outage behavior, and engine restart
   blast radius against the same image on the Kubernetes path.
5. Do not widen eligibility until distributed ownership and stable routing are
   demonstrated under two backend replicas.

The decision criterion is not merely a faster cold start. The Dagger lane needs
to save enough standing pod/scheduler overhead to justify a larger shared
failure domain and the loss of Kubernetes-native customization.

## References

- [PR #7135](https://github.com/archestra-ai/archestra/pull/7135) — current
  Kubernetes idle-hibernation implementation and its known demand race.
- [Dagger 0.21.7 service semantics](https://github.com/dagger/dagger/blob/f0a16837a9fb53572f3cdd60c46543bb827efe5d/docs/versioned_docs/version-0.21.7/using-dagger/services.mdx)
  — content-addressed hostnames, just-in-time lifecycle, cross-client
  de-duplication, reference-based stop, health checks, and host port tunnels.
