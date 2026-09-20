---
title: Using Claude Desktop (Cowork)
category: Examples
order: 9
description: Route Claude Desktop's inference and tools through Archestra
lastUpdated: 2026-09-19
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

![Claude Desktop connected to a gateway](/docs/automated_screenshots/platform-claude-desktop-example_settings.webp)

Claude Desktop uses a downloadable setup helper or a terminal command. The setup script supports macOS, Windows, and Linux. Linux requires Anthropic's official Desktop beta.

## Use Case

You use a Claude Pro or Max subscription for local Cowork tasks. Archestra routes those requests through its LLM Proxy for policies and request logs. For example, ask Cowork to summarize a local project README using Haiku.

## Requirements

Install Claude Desktop. The downloadable installer uses Desktop’s built-in runtime. You do not need Node.js, Python, or Claude Code. Subscription access requires your existing Claude subscription.

MCP sign-in requires HTTPS, including local deployments. Use a trusted local HTTPS reverse proxy for development. Inference alone supports HTTP on localhost and loopback IP addresses. The Anthropic proxy must forward to Anthropic, without a Vertex AI endpoint override.

## Setup

Connecting the LLM Proxy switches Desktop to third-party inference mode. Existing Claude conversations do not appear in that mode. The installer does not delete them or migrate them. Third-party conversations stay on your device, separate from standard Claude history. See [Revert](#revert) before switching. Tools-only setup does not require third-party inference.

Open **Connect** and select **Claude Desktop**. Review your authentication, model, gateway, and platform. The platform defaults to your detected operating system and remains editable. Finish active Desktop tasks before installing. Download the installer and open the `.mcpb` file in normal Claude Desktop. Confirm installation in Desktop’s native dialog. The setup helper opens your browser for sign-in and restart confirmation. You can remove the helper from Desktop’s Extensions settings afterward.

The **Advanced: terminal setup** option requires Python 3.9+ and Claude Code for subscription sign-in. It remains available for existing third-party profiles that cannot install Desktop extensions.

The installer checks inference before changing your configuration. It backs up changed files, preserves manually created profiles, and restarts Desktop. Rerunning setup replaces the installer-managed connection, including its gateway and skills settings. Installing from another deployment replaces the previous managed connection. If macOS rejects automatic quitting, the installer waits for you to quit from Desktop’s menu. You do not download or import a profile manually. Keep the download and generated command private; they contain an expiring setup ticket. Installation redeems the ticket once. Download a new installer if it expires.

## Connect From An Agent

The Connect prompt automates setup for coding clients with permitted host-terminal access. Ordinary Cowork cannot reliably run installation in Auto mode. Use **Connect → Claude Desktop** and download the setup helper instead. Installing it is your direct action; it does not require a Cowork installer tool call. Desktop’s native extension confirmation remains required.

## Subscription Inference

Subscription setup opens Claude’s browser authorization page. Its consent screen names the subscription connection “Claude Code”. The CLI does not need to be installed. Only inference access is requested. The resulting token stays on your computer. You do not copy it into Archestra. Valid existing tokens are reused when you rerun setup. Tokens expire after up to one year and can be revoked earlier. Rerun setup after expiration or revocation.

Model access and usage limits depend on your Anthropic account. Send a message and check **LLM Proxy Logs** for its response and billing mode. Subscription credentials are recorded with subscription billing mode.

## API-Key Inference

Choose **API key** in the review step's authentication settings. Archestra provisions a personal virtual key backed by your configured Anthropic key. The installer applies it without a Claude subscription sign-in.

## Tools And Skills

Installing the gateway does not complete its authentication or enable it for every conversation. Follow the **Enable your gateway in Claude Desktop** step on Connect after restarting. A connected checkmark in Settings confirms the connection, not its selection for your conversation. Ask Claude to list the gateway's tools to verify availability.

The skills selected on Connect install automatically after Desktop restarts. Setup pins the selected snapshot; rerun Connect to install an updated snapshot.

## Revert

To return to standard Claude Desktop, choose Anthropic sign-in on Desktop's sign-in screen. Sign in with your original Claude account to access its conversations. This is [Anthropic's documented return path](https://claude.com/docs/third-party/claude-desktop/installation#single-machine-setup). If your Desktop version does not expose that option, contact your administrator or Anthropic support. Organization policy can hide Claude sign-in.

Keep the `Claude-3p` application data directory. Deleting it can remove conversations created in third-party mode. Removing the setup extension alone does not revert your inference settings.

To use another third-party profile, select it in **Configure Third-Party Inference** and restart Desktop. To return to another deployment, run its installer again. The installer keeps `.before-archestra` backups of existing configuration files it changes. These backups do not include conversation history.

See [Connect Your Agents](/docs/platform-connection) for other clients.

In **Logs → LLM Proxy**, filter by **Claude Desktop** to review its requests. Claude Code has a separate filter. Older requests with generic Claude attribution appear as **Claude Code**.
