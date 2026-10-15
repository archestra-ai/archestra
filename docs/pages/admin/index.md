---
title: Admin
description: Deploy Archestra, assign access, connect identity providers, and monitor operations
order: 7
lastUpdated: 2026-10-15
---

Install Archestra, decide who can use its resources, and verify that requests run with the intended identity and limits.

For a first deployment, choose [Docker or Helm](/docs/admin/deployment), preserve the database and encryption keys, and verify access before connecting clients. For an existing deployment, use the guides below to configure roles, environment isolation, sign-in, and telemetry.

Organization roles and individual resource grants work together: a person may be able to open Agents without being allowed to use a particular agent. Start with [Access Control](/docs/admin/access-control) when diagnosing missing resources. Deployment-wide settings live in [Configuration](/docs/reference/configuration).
