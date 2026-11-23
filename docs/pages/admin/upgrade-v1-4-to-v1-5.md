---
title: Upgrade from v1.4 to v1.5
description: What v1.5 changes for your deployment, and the steps to upgrade from v1.4 with Helm or Docker
order: 11
draft: true
lastUpdated: 2026-11-23
---

<!-- Draft: `draft: true` keeps this page off the docs site. Add each operator-facing v1.5 change here as it lands on main. Before 1.5.0, finish the page with the archestra-upgrade-guide skill and remove `draft: true`. Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

## What Changes for Your Deployment

### Behavior Changes

- **Agent Runtime accounts:** a runtime's **Claude account** setting from v1.4 no longer restricts its agents. After the upgrade the runtime shows both cards selected under **Accounts that can run it**, and whoever builds an agent on it chooses the agent's accounts. Existing agents keep the account they run on. To keep a runtime on one account, go to **Settings → Agents → Runtimes**, open the runtime with **Edit runtime**, select one card under **Accounts that can run it** on **Runtime settings**, and save. That rule applies to every agent on the runtime at once.

## Helm Values

A v1.4 values file renders with the v1.5 chart, but these keys need changes:

- `archestra.runAsNonRoot`: the web, worker, and migration pods run as UID 10001 by default. Before you upgrade, run `chown -R 10001` on file-storage and diagnostics volumes on NFS or `hostPath`: Kubernetes regroups other volume types for you. On OpenShift, set it to `false`, so its restricted SCC assigns the UID. To keep running as root, set it to `false` and set `archestra.podSecurityContext.runAsUser` to `0`: the `-slim` image runs as UID 10001 on its own.
- `archestra.imageVariant`: the chart runs `archestra/platform:<version>-slim`, which has no bundled PostgreSQL or quickstart tooling. If you mirror images, mirror the `-slim` tag. If you pin `archestra.imageTag` to a release before 1.5.0, set this to `""`: those releases have no `-slim` image.
- `archestra.readOnlyRootFilesystem`: with `archestra.runAsNonRoot`, the platform containers' root filesystem is read-only by default. The chart mounts an `emptyDir` at `/tmp`, `/run/archestra`, `/app/data`, `/home/archestra`, and `/app/frontend/.next/cache`. If you run a custom image or command that writes anywhere else, mount a volume at that path with `archestra.extraVolumes` and `archestra.extraVolumeMounts`, or set this value to `false`.

## APIs

If a script reads the member list from the Adoption API, switch it to the new endpoint:

- [`GET /api/connected-clients/adoption`](/docs/reference/api/apps#tag/connection-setups/GET/api/connected-clients/adoption) now returns `memberCount` and only the members with an agent or traffic. Members who have connected nothing are counted but not listed.
- To list every member, page through [`GET /api/connected-clients/adoption/members`](/docs/reference/api/apps#tag/connection-setups/GET/api/connected-clients/adoption/members). It filters by `state`, searches with `search`, and returns up to 1000 members per page.
