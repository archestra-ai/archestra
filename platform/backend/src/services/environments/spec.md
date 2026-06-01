# Environments

## Summary

An **Environment** is a deployment target that controls *where* MCP
servers run and *who* is allowed to deploy into it. An environment 
is a property of a catalog item: each catalog item belongs to exactly one
environment. Each environment defines:

- a **Kubernetes namespace** the server's pods are deployed into - **actual implementation deferred**
- a **Kubernetes network policy** — **deferred to a later spec**;.
- a **validation rule** (regex) applied to user-supplied configuration values — identical
  semantics to today's preset `validation_regex`.
- a **`restricted` flag** that gates assignment: assigning a catalog item to a restricted
  environment requires the org-wide `environment:admin` permission, while unrestricted
  environments are open to anyone who can create catalog items. The implicit **default**
  environment (catalog items with `environment_id = null`) carries the same flag, stored on the
  organization (`default_environment_restricted`); when set, creating a catalog item without
  choosing an environment is itself `environment:admin`-gated.

Environments give an org three things at once:

1. **Isolation** — different namespaces (and network policies) for sandbox vs. staging
   vs. production workloads, so a sandbox MCP cannot reach production resources.
2. **RBAC for deployment** — only users holding `environment:admin` can assign catalog items to a
   `restricted` environment (including the default environment when the org has marked it
   restricted). A regular user can experiment in a sandbox (unrestricted); assigning into a
   restricted environment such as production is an admin-gated action.
3. **Promotion** — a path to move a server up through environments (sandbox → staging →
   production) as it matures. Promotion is deliberately thin: an admin clones an existing
   server, the add-MCP form reappears pre-filled, and the admin changes the environment and
   visibility scope. There is no dedicated promotion API.

This feature is built **in parallel** with the existing "presets" feature. Presets are hidden
behind a feature flag and removed later. **There is no migration and no backward compatibility
between presets and environments.**

## User story

> A user has a **sandbox** environment to run an MCP server or agent. The sandbox cannot reach
> production resources. Once the user considers the MCP ready, they ask an admin to **promote**
> it to **staging**, where the admin verifies the server works and its guardrails behave. When
> satisfied, the admin promotes it to **production**.