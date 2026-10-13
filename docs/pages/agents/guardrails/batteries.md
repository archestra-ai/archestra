---
title: Guardrail Batteries
sidebarTitle: Batteries
description: Cover an MCP server's tools with a ready-made policy package
order: 2
alpha: "Turn it on with [`ARCHESTRA_BETA=true`](/docs/reference/configuration#ARCHESTRA_BETA), then restart the backend."
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A [battery](https://www.openappa.com/batteries) is a ready-made policy for a set of tools, usually one MCP server such as GitHub, Linear, or Google Workspace. Include it, and those tools are covered without writing rules. See the [available batteries](https://www.openappa.com/available-batteries).

![The Batteries tab listing bundled batteries with their source, status, and servers](/docs/automated_screenshots/platform-openappa_batteries.webp)

## Include a Battery

Including a battery needs [`openappaPolicy:update`](/docs/reference/permissions#openappaPolicy:update). Binding a credential or uploading a package also needs [`credential:update`](/docs/reference/permissions#credential:update).

- **Ask the agent:** click the **Batteries** card on **Overview**. The agent finds the batteries that fit your servers.
- **Do it yourself:** on the **Batteries** tab, click a battery's edit button and attach it to an installed MCP server.
- **On install:** when you install an MCP server from the registry, Archestra offers its battery.

## Fix a Battery

An included battery that cannot run shows a problem instead of **Active**:

- **Needs a credential:** the battery calls an API, for example to check if a repository is public. Bind a key from [Credentials](/docs/admin/security/credentials) in the battery's edit dialog. A battery holds no keys, and the key never appears in the policy.
- **No server bound:** attach the battery to an installed MCP server.

## Write Your Own

[Write a battery](https://www.openappa.com/write-a-battery), then click **Upload package** on the **Batteries** tab. A battery can bring its own helper programs, such as sanitizers and authorities. Those that call APIs run in the [code sandbox](/docs/agents#code-sandbox).
