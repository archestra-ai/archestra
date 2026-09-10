---
title: Using Claude Desktop (Cowork)
category: Examples
order: 9
description: Route Claude Desktop's inference and tools through Archestra
lastUpdated: 2026-09-10
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

![Claude Desktop connected to a gateway](/docs/automated_screenshots/platform-claude-desktop-example_settings.webp)

Claude Desktop uses a downloadable setup helper or a terminal command. The setup script supports macOS, Windows, and Linux. Linux requires Anthropic's official Desktop beta.

## Use Case

You use a Claude Pro or Max subscription for local Cowork tasks. Archestra routes those requests through its LLM Proxy for policies and request logs. For example, ask Cowork to summarize a local project README using Haiku.

## Requirements

Install Claude Desktop, Node.js 18+, and Python 3.9 or newer. Subscription authentication also requires the official Claude Code CLI. On Windows, use the native CLI installer. API-key authentication uses an Anthropic key configured in Archestra.

Remote MCP and marketplace endpoints require HTTPS. HTTP works for local development on localhost and loopback IP addresses. The Anthropic proxy must forward to Anthropic, without a Vertex AI endpoint override.

## Setup

Open **Connect** and select **Claude Desktop**. Review your authentication, model, gateway, and platform. The platform defaults to your detected operating system and remains editable. Finish active Desktop tasks before installing. Download the installer and open the `.mcpb` file in normal Claude Desktop. Confirm installation in Desktop’s native dialog. The setup helper opens a separate terminal and applies the reviewed configuration. You can remove the helper from Desktop’s Extensions settings afterward.

Already using a third-party Desktop profile? Use **Use terminal instead**. Run that command in a terminal, or PowerShell on Windows.

The installer checks inference before changing your configuration. It backs up changed files, preserves manually created profiles, and restarts Desktop. Rerunning setup replaces the installer-managed connection, including its gateway and skills settings. Installing from another deployment replaces the previous managed connection. If macOS rejects automatic quitting, the installer waits for you to quit from Desktop’s menu. You do not download or import a profile manually. Keep the download and generated command private; they contain an expiring setup ticket. Installation redeems the ticket once. Download a new installer if it expires.

## Connect From An Agent

The Connect prompt automates setup for coding clients with permitted host-terminal access. Ordinary Cowork cannot reliably run installation in Auto mode. Use **Other ways to connect → Claude Desktop** and download the setup helper instead. Installing it is your direct action; it does not require a Cowork installer tool call. Desktop’s native extension confirmation remains required.

## Subscription Inference

Subscription setup opens Claude's browser sign-in through `claude setup-token`. The resulting token stays on your computer. You do not copy it into Archestra. Valid existing tokens are reused when you rerun setup. Tokens expire after up to one year and can be revoked earlier. Rerun setup after expiration or revocation.

Model access and usage limits depend on your Anthropic account. Send a message and check **LLM Proxy Logs** for its response and billing mode. Subscription credentials are recorded with subscription billing mode.

## API-Key Inference

Choose **API key** in the review step's authentication settings. Archestra provisions a personal virtual key backed by your configured Anthropic key. The installer applies it without a Claude subscription sign-in.

## Tools And Skills

MCP connectors require separate browser authorization in Desktop's **Settings → Connectors**. Install your configured skills marketplace under **Settings → Plugins**.

## Revert

Select a manually created profile in **Configure Third-Party Inference** and restart Desktop. To return to another deployment, run its installer again. The installer also keeps `.before-archestra` backups of existing files it changes.

See [Connect Your Agents](/docs/platform-connection) for other clients.

In **Logs → LLM Proxy**, filter by **Claude Desktop** to review its requests. Claude Code has a separate filter. Older requests with generic Claude attribution appear as **Claude Code**.