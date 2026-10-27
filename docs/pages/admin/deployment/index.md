---
title: Deployment
description: Choose how to run Archestra and prepare a production instance
order: 1
lastUpdated: 2026-10-27
---

Run Archestra locally to try it, or install it on Kubernetes for a shared instance.


<span id="docker-deployment"></span><span id="quickstart-deployment"></span><span id="using-external-postgresql"></span><span id="helm-deployment"></span><span id="installation"></span><span id="core-configuration"></span><span id="database-configuration"></span><span id="accessing-the-platform"></span><span id="code-sandbox"></span><span id="connect-page-settings"></span><span id="cost-statistics-index"></span><span id="crossplane"></span><span id="enable-fast-logs-user-lists"></span><span id="infrastructure-as-code"></span><span id="keep-alive-timeouts"></span><span id="mcp-apps-sandbox"></span><span id="mcp-gateway-oauth-public-origin"></span><span id="release-channels-and-upgrades"></span><span id="routing-the-llm-proxy-away-from-the-frontend"></span><span id="ssrf-protection-for-mcp-server-pods"></span><span id="terraform"></span><span id="upgrade-oauth-clients"></span><span id="scaling"></span><span id="install-with-helm"></span><span id="verify-the-installation"></span><span id="scale-web-and-worker-pods"></span>

- **Local:** use the Docker command in [Get Started](/docs/get-started#run-archestra). Its named volumes preserve your database and application data.
- **Development:** use the [Developer Quickstart](/docs/contributing/developer-quickstart) to run Archestra from source.

- **Production:** follow [Helm](/docs/admin/deployment/helm) for installation and [Production](/docs/admin/deployment/production) for the deployment decisions to make before serving traffic.
