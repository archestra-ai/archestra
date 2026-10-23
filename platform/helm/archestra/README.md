# Archestra Helm chart

## Web and worker scheduling

`archestra.nodeSelector`, `archestra.tolerations`, and `archestra.affinity` are
shared scheduling defaults. Override each field independently under
`archestra.web` or `archestra.worker`:

- An omitted or `null` field inherits the corresponding shared value.
- A nonempty field replaces the entire shared field; maps are not merged and
  toleration lists are not appended.
- An explicit `{}` for `nodeSelector` or `affinity`, or `[]` for `tolerations`,
  clears that shared field for the tier.

For example, label general-purpose nodes `nodepool=general-purpose` and
memory-optimized nodes `nodepool=memory-optimized`. If memory-optimized nodes
also have the taint `dedicated=workers:NoSchedule`, use:

```yaml
archestra:
  web:
    nodeSelector:
      nodepool: general-purpose
    tolerations: []
  worker:
    enabled: true
    nodeSelector:
      nodepool: memory-optimized
    tolerations:
      - key: dedicated
        operator: Equal
        value: workers
        effect: NoSchedule
```

Use labels and taints that exist on your cluster. A toleration permits scheduling
on a tainted node; the node selector constrains placement. Tier `affinity` accepts
standard Kubernetes node affinity and pod (anti-)affinity rules. A node selector
and required node affinity must both be satisfied.

`archestra.topologySpreadConstraints` remains shared; constraints without an
explicit label selector are scoped to each Deployment separately.

With `archestra.worker.enabled: false`, the main platform Deployment runs web
and background jobs together and uses `archestra.web` scheduling. Worker
scheduling values are unused. Migration Jobs and network policy probes continue
to use the shared `nodeSelector` and `tolerations`; PostgreSQL uses its own
subchart settings.
