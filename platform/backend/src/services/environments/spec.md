# Environments

## Summary

An **Environment** is a deployment target that controls *where* MCP
servers run and *who* is allowed to deploy into it. An environment 
is a property of a catalog item: each catalog item belongs to exactly one
environment. Each environment defines:


1. **Deployment Isolation** — different namespaces for MCP pods, so a sandbox MCP can't reach production resources. It's implemented via a k8s namespace optionally defined for each environment.

2. **Network Isolation** — UI to edit a k8s NetworkPolicy for the environment.

3. **RBAC for deployment** — Each environment could be marked as `restricted`. Only users holding `environment:admin` or `environment:deploy-to-restricted` can assign catalog items to a
   `restricted` environment.

4. **Validation** — a **validation rule** (regex) applied to user-supplied configuration values — identical
  semantics to today's preset `validation_regex`.

5. **Promotion** — a path to move a server up through environments (sandbox → staging →
   production) as it matures. Promotion is deliberately thin: an admin clones an existing
   server, the add-MCP form reappears pre-filled, and the admin changes the environment and
   visibility scope. There is no dedicated promotion API.

## Network policies

A **Network Policy** is an organization-scoped, reusable egress profile. It is separate from
environments so the same policy can be reused by MCP server installations today and agent
runtime/execution later.

Network policies define:

- **egress mode**:
  - `off`: no internet egress except cluster-internal traffic needed by the runtime.
  - `restricted`: allow selected CIDRs, and when an FQDN provider is available, selected domain rules.
  - `unrestricted`: allow all egress.
- **allowed CIDRs**: IPv4/IPv6 CIDR ranges enforced with vanilla Kubernetes `NetworkPolicy`.
- **domain preset** for restricted mode:
  - `none`: start from an empty allowlist.
  - `common_dependencies`: allow common package/source-control domains, then add custom domains.
  - `package_managers`: allow common package manager domains, then add custom domains.
- **additional allowed domains**: exact domains and wildcard subdomains such as
  `api.example.com` and `*.example.com`; requires Cilium `CiliumNetworkPolicy`,
  GKE `FQDNNetworkPolicy`, or EKS Auto Mode `ApplicationNetworkPolicy`.

Policy resolution:

1. An environment can reference one default network policy.
2. MCP server catalog items select an environment; they do not carry their own network policy.
3. MCP server installations inherit the policy from the catalog item's environment.
4. Effective policy order is: environment default -> built-in platform default.

UX:

- Network policy CRUD belongs on a dedicated page.
- Environment create/edit selects a default network policy.
- MCP catalog/install forms do not expose network policy controls.

Runtime mapping:

- Archestra owns Kubernetes `NetworkPolicy` objects generated from the effective policy.
- Policies select only Archestra-managed workload pods for the specific installation/runtime.
- Kubernetes network policies are additive, so Archestra must generate a complete managed policy
  set for each selected workload and avoid relying on policy ordering.
- Kubernetes `NetworkPolicy` is L3/L4 only. The managed object enforces `off`, DNS, and CIDR
  egress rules.
- When the cluster exposes Cilium `CiliumNetworkPolicy`, GKE `FQDNNetworkPolicy`, or EKS
  Auto Mode `ApplicationNetworkPolicy`, Archestra uses it for policies with domain presets
  or custom domains. Without an FQDN provider, the UI explains that domain rules are unavailable.
- EKS Auto Mode DNS rules only apply to workloads running on Auto Mode-launched EC2 nodes.
- Enforcement requires a Kubernetes network plugin that supports `NetworkPolicy`.
- The Helm chart service account needs RBAC for CRUD on `networkpolicies.networking.k8s.io`
  plus any detected FQDN object type.

This feature is built **in parallel** with the existing "presets" feature. Presets are hidden
behind a feature flag and removed later. **There is no migration and no backward compatibility
between presets and environments.**

## User story

> A user has a **sandbox** environment to run an MCP server or agent. The sandbox cannot reach
> production resources. Once the user considers the MCP ready, they ask an admin to **promote**
> it to **staging**, where the admin verifies the server works and its guardrails behave. When
> satisfied, the admin promotes it to **production**.
