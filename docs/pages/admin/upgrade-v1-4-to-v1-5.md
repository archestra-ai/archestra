---
title: Upgrade from v1.4 to v1.5
description: What v1.5 changes for your deployment, and the steps to upgrade from v1.4 with Helm or Docker
order: 11
draft: true
---

<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

<!-- Draft: `draft: true` keeps this page off the docs site. Add each operator-facing v1.5 change here as it lands on main. Before 1.5.0, finish the page with the archestra-upgrade-guide skill and remove `draft: true`. Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

## Helm Values

A v1.4 values file renders with the v1.5 chart, but these keys need changes:

- `archestra.runAsNonRoot`: the web, worker, and migration pods run as UID 10001 by default. Before you upgrade, run `chown -R 10001` on file-storage and diagnostics volumes on NFS or `hostPath`: Kubernetes regroups other volume types for you. On OpenShift, set it to `false`, so its restricted SCC assigns the UID. To keep running as root, set it to `false` and set `archestra.podSecurityContext.runAsUser` to `0`: the `-slim` image runs as UID 10001 on its own.
- `archestra.imageVariant`: the chart runs `archestra/platform:<version>-slim`, which has no bundled PostgreSQL or quickstart tooling. If you mirror images, mirror the `-slim` tag. If you pin `archestra.imageTag` to a release before 1.5.0, set this to `""`: those releases have no `-slim` image.
- `archestra.readOnlyRootFilesystem`: with `archestra.runAsNonRoot`, the platform containers' root filesystem is read-only by default. The chart mounts an `emptyDir` at `/tmp`, `/run/archestra`, `/app/data`, `/home/archestra`, and `/app/frontend/.next/cache`. If you run a custom image or command that writes anywhere else, mount a volume at that path with `archestra.extraVolumes` and `archestra.extraVolumeMounts`, or set this value to `false`.

## APIs

Auto Routing's past sessions now serve every router that reads them, so two calls changed:

- [`DELETE /api/auto-routing/backfill/{id}`](/docs/reference/api/llm-proxy/auto-routing#tag/auto-routing/DELETE/api/auto-routing/backfill/{id}) replaces the old cancel call without an id. Pass the id of the job to stop and, as the `phase` query parameter, the phase you saw it in (`scan` or `score`); a call for a job that is no longer running in that phase returns `404`. [`POST /api/auto-routing/backfill/score`](/docs/reference/api/llm-proxy/auto-routing#tag/auto-routing/POST/api/auto-routing/backfill/score) pays with the organization-wide Jev key and refuses a run, with `400`, while there is none.
- Router responses carry `learnFromPastSessions` and `readsPastSessions` in place of `usesPastSessions`. The upgrade keeps learning on for the router that read past sessions before, and off for the others. Routers created through the API learn from past sessions unless `learnFromPastSessions: false` is passed; a router a v1.4 process creates while the upgrade runs starts with learning off.

If a script reads the member list from the Adoption API, switch it to the new endpoint:

- [`GET /api/connected-clients/adoption`](/docs/reference/api/apps#tag/connection-setups/GET/api/connected-clients/adoption) now returns `memberCount` and only the members with an agent or traffic. Members who have connected nothing are counted but not listed.
- To list every member, page through [`GET /api/connected-clients/adoption/members`](/docs/reference/api/apps#tag/connection-setups/GET/api/connected-clients/adoption/members). It filters by `state`, searches with `search`, and returns up to 1000 members per page.

## Guardrails

v1.5 removes the ways a refused call got through, so check these before you upgrade:

- **Waivers:** if you set [`ARCHESTRA_OPENAPPA_SOFT_BLOCK_MODE`](/docs/admin/deployment/configuration#ARCHESTRA_OPENAPPA_SOFT_BLOCK_MODE) to `allow`, or **Other blocked calls** to **Waive the block**, refused calls stay refused after the upgrade, and your deployment runs [Enforce](/docs/agents/guardrails#off-observe-and-enforce). To keep agents working while you tune the policy, set `mode` to `observe` once the rollout finishes.
- **Sessions a yell turned off:** they are checked again.
- **`X-Archestra-Unattended`:** clients that send it no longer get unattended approvals. Only Agent Runtime runs count as unattended.
- **Rolling upgrade:** until every replica runs v1.5, a v1.4 replica still waives as v1.4 did, honors the header, and turns sessions off on a yell. Change `mode`, `personApproval`, or `enforcedMarks` only after the rollout: a v1.4 replica reads a saved `observe` as waiving every approval and every refused call, and it ignores `enforcedMarks`.
- **Approval set to `unattended` or `everywhere`:** v1.5 opens new sessions on a separate line for these settings, and a v1.4 replica can't continue them. Until every replica runs v1.5, such a session fails when one of its requests reaches a v1.4 replica, so upgrade all replicas at once, for example with `archestra.deploymentStrategy.type` set to `Recreate`. A rollback to v1.4 can't continue these sessions either.
- **Rollback:** before any v1.4 replica takes traffic, set `mode` to `enforce` or `off`. v1.4 reads a saved `observe` as waiving every approval and every refused call, whatever `enforcedMarks` holds. Sessions opened under Observe stay on its separate line, which v1.4 can't continue, so they fail after the rollback; start new sessions.
