---
title: Guardrail Batteries
sidebarTitle: Batteries
description: Cover an MCP server's tools with a ready-made policy package
order: 5
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A [battery](https://www.openappa.com/batteries) is a ready-made policy for a set of tools, usually one MCP server such as GitHub, Linear, or Google Workspace. Include it, and those tools are covered without writing rules. You can include the batteries that ship with Archestra. Your own battery packages are not supported yet.

![The Batteries tab listing bundled batteries with their source, status, and servers](/docs/automated_screenshots/platform-openappa_batteries.webp)

## Include a Battery

Including a battery needs [`guardrailsPolicy:update`](/docs/reference/permissions#guardrailsPolicy:update). Binding a credential also needs **Can use** on that credential. See [Who Can Manage a Credential](/docs/admin/security/credentials#who-can-manage-a-credential).

- **Ask the agent:** open any chat button on the Guardrails pages and ask which batteries fit your servers.
- **Do it yourself:** on the **Batteries** tab, open a battery and click **Attach to a server**.
- **On install:** when you finish adding an MCP server from the registry, click **Configure Guardrails with agent**.

## Fix a Battery

An included battery that cannot run shows its problem on the **Batteries** tab instead of **Configured**:

- **Credential not configured:** the battery calls an API, for example to check if a repository is public. Open the battery and bind a key from [Credentials](/docs/admin/security/credentials). The key never appears in the policy.
- **Server not configured:** attach the battery to an installed MCP server.
- **Server conflict:** more than one MCP server has the battery's tool prefix, so it cannot tell which one to check. Attach it to one server.

What to know:

- Archestra saves the key beside the policy, not in it. So you can bind a key before the battery is included, and while [Git sync](/docs/agents/guardrails/git-sync) owns the policy.
- The policy text cannot hold a `[credentials]` line, and a save with one is refused.

## When a Revision Is Refused

A refused revision does not turn your guardrails off. The runtime keeps enforcing the last policy that worked, and the **Policy** tab says **an earlier composition stays enforced**. Fix what the refusal message names, and save again.

If no revision ever worked, the **Policy** tab says **nothing is enforced**, and calls the policy governs are refused until a revision works.
