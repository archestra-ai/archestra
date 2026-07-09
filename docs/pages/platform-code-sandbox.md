---
title: Code Sandbox
category: Agents
order: 5
description: A private Linux container where an agent runs code during a chat
lastUpdated: 2026-07-06
---

The code sandbox is a private Linux container where an agent runs code during a chat. It runs shell commands and Python, isolated from your own infrastructure — no host access, and no network beyond what the agent's [environment](./platform-environments) allows. Each conversation gets its own sandbox, created the first time the agent runs something.

![A chat where the agent runs a shell command in the sandbox with run_command and reports the result](/docs/automated_screenshots/platform-code-sandbox_run-command.webp)

## Running Commands

The agent runs shell commands with the `run_command` tool. Files a command writes stay on disk for the next command, so the agent builds up work across several steps. The working directory is `/home/sandbox`.

Python runs in a ready-made project at `/home/sandbox`. The `python3` interpreter has numpy, pandas, and httpx already installed. The agent installs more packages with `uv add <package>`. Pin versions when a result has to be reproducible, since a later install can resolve to a newer release.

Other languages and command line tools can be installed by the agent when necessary.

## Files

Files you attach to a chat land in the sandbox automatically, under `/home/sandbox/attachments/`. The agent works with them without any extra step from you.

When the agent produces a file — a cleaned dataset or a chart, for example — it saves the file to the conversation's Files panel, where you can download it. Attachments above the size limit are skipped, and the agent is told which ones.

## Skills

When the agent loads a [skill](./platform-agent-skills), the skill's files mount at `/skills/<name>`, so any scripts it bundles run in the sandbox. The skill's Python modules import directly, with no path setup.

## How the Sandbox Runs

The sandbox keeps no long-lived container. The source of truth is an append-only command log in Archestra database. Each command starts a fresh container from a warm base image, replays the recorded history, then runs the new step and appends it.

Archestra runs the containers with [Dagger](https://dagger.io), a programmatic container engine. Its layer cache is content-addressed, so replaying an unchanged history is a cache hit and the common path stays fast. A cold replay reruns the whole history — still correct, just slower.

This design makes state cheap to rebuild — so an engine crash costs you nothing. If the engine restarts or drops a cached layer, the next command reconstructs the exact state from the log.

One trade-off follows. A command that reads the network, the clock, or a random source can return a different result on a cold rebuild. `uv add` without a pinned version can resolve to a newer release the second time. Pin versions when a result has to be reproducible.

## Security

The sandbox limits what one user's code can reach — it is not a defense against a determined attacker. The case it handles is the careless script an agent just generated, kept away from everyone else's work.

Each container runs as a non-root user, with no host mounts and no backend environment variables inside. CPU, memory, and wall-clock caps bound every command.

Network access is on, because installers like uv and npm need it. Egress follows the [environment's network policy](./platform-environments), applied to the Dagger engine pod. Leave that policy unrestricted and the engine can reach link-local and cloud-metadata endpoints — restrict it in production.

## Limits

Each command runs under fixed caps: 30 seconds of CPU, 1 GiB of memory, and 120 seconds of wall-clock time. Command output is captured up to 256 KiB, and a file the agent exports can be up to 16 MiB. A very long chain of commands eventually reaches a history limit — the agent then starts a fresh sandbox. Admins can tune the caps; see [Deployment](./platform-deployment#code-sandbox).

## Enabling the Sandbox

The quickstart Docker image and the Helm chart enable the sandbox by default. To turn it off, set `ARCHESTRA_CODE_RUNTIME_ENABLED=false` in Docker, or `archestra.codeRuntime.enabled=false` in Helm values. A manual deployment needs a Dagger runner host in `ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`. Without a reachable runner host, the feature stays off. `ARCHESTRA_CODE_RUNTIME_ENABLED` only controls whether local dev, quickstart, and Helm deploy the embedded Dagger engine. See [Deployment](./platform-deployment#code-sandbox) for the full list.

Running a command needs the `sandbox:execute` permission. See [Access Control](./platform-access-control).

## Use Case: Cleaning a Spreadsheet

An analyst attaches `q3-signups.csv` to a chat and asks the agent to drop duplicate rows and chart signups by week.

- The file lands in the sandbox at `/home/sandbox/attachments/q3-signups.csv` automatically.
- The agent runs Python with pandas to remove duplicates and group the rows by week.
- It writes `signups-by-week.png` and a cleaned `q3-signups-deduped.csv`, then saves both to the Files panel.
- The analyst downloads the chart and the cleaned file straight from the chat.
