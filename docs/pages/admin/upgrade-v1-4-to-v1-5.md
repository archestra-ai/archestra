---
title: Upgrade from v1.4 to v1.5
description: What v1.5 changes for your deployment, and the steps to upgrade from v1.4 with Helm or Docker
order: 11
draft: true
lastUpdated: 2026-11-20
---

<!-- Draft: `draft: true` keeps this page off the docs site. Add each operator-facing v1.5 change here as it lands on main. Before 1.5.0, finish the page with the archestra-upgrade-guide skill and remove `draft: true`. Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

## Helm Values

A v1.4 values file renders with the v1.5 chart, but these keys need changes:

- `archestra.runAsNonRoot`: the web, worker, and migration pods run as UID 10001 by default. Before you upgrade, run `chown -R 10001` on file-storage and diagnostics volumes on NFS or `hostPath`: Kubernetes regroups other volume types for you. On OpenShift, set it to `false`, so its restricted SCC assigns the UID. To keep running as root, set it to `false`.
- `archestra.podSecurityContext: null`: it no longer clears the pod security context on its own. Also set `archestra.runAsNonRoot: false`.
