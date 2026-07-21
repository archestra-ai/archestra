---
title: Code Sandbox
category: Agents
order: 5
description: A private Linux container where an agent runs code during a chat
lastUpdated: 2026-07-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

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

## The Dagger Engine

Archestra builds the containers with [Dagger](https://dagger.io), a programmatic container engine. Dagger is really a build engine, which is why it fits — replaying a sandbox has the same shape as rebuilding an image, so each step gets cached like a build layer.

One engine serves the whole deployment. The Helm chart runs it for you, or you can point Archestra at an engine you run yourself. See [Deployment](./platform-deployment#code-sandbox).

The base image is Debian with Python 3.12 and uv. The engine builds the sandbox base from it the first time, then reuses it. Point the engine at a pre-baked base to skip that build — worth doing when egress is restricted, since it drops the calls to the Debian mirrors and PyPI.

The engine is also the throughput limit. It runs ten commands at once and queues fifty more; past that a command fails with a capacity error. Raise both caps with `ARCHESTRA_DAGGER_RUNTIME_MAX_CONCURRENT` and `ARCHESTRA_DAGGER_RUNTIME_MAX_QUEUE_LENGTH`, and give the engine the CPU and memory to match.

### Caches

Dagger's cache is content-addressed. Adding a command to a conversation leaves every earlier step unchanged, so those come back from cache and only the new one runs. That is the common path, and it is what makes replay affordable.

A cold cache is the slow case — the engine reruns the whole history before your command. Still correct, just slower. The cache sits on the engine's volume and is shared by every sandbox in the deployment.

### Trade-offs

Replay is what keeps the sandbox durable. No state lives in the container, so a restart, a crash, or an evicted layer loses nothing.

What it gives up is repeatability. A command that reads the network, the clock, or a random source can come back different on a rebuild. `uv add` without a version can resolve to a newer release the second time. Pin versions when a result has to be reproducible.

It also gives up unlimited history. Every replayed step stacks a filesystem layer, and the kernel caps how many fit. A long enough chain reaches that limit, and the agent starts a fresh sandbox.

And nothing keeps running between commands. A server the agent starts is gone by the next step — only files survive.

## Security

The sandbox is container isolation on a shared engine. It keeps one user's code away from your infrastructure and away from other people's work, and that is the honest limit of it. A container escape reaches the engine, and the engine serves the whole deployment. Treat the sandbox as protection against the careless script an agent just generated — not as a place to run code you actively distrust.

Each container runs as a non-root user, with no host mounts and no backend environment variables inside. CPU, memory, and wall-clock caps bound every command. A sandbox belongs to one user and one conversation, so an agent cannot reach another conversation's files.

Network access is on, because installers like uv and npm need it. Egress follows the [environment's network policy](./platform-environments), applied to the Dagger engine pod. Leave that policy unrestricted and the engine can reach link-local and cloud-metadata endpoints — restrict it in production.

The engine pod itself runs privileged and as root. Building containers is what requires that, so schedule it on nodes where those permissions are acceptable.

## Limits

Each command runs under fixed caps: 30 seconds of CPU, 1 GiB of memory, and 120 seconds of wall-clock time. Command output is captured up to 256 KiB, and a file the agent exports can be up to 16 MiB. Admins can tune the caps; see [Deployment](./platform-deployment#code-sandbox).

## Enabling the Sandbox

The quickstart Docker image and the Helm chart enable the sandbox by default. To turn it off, set `ARCHESTRA_CODE_RUNTIME_ENABLED=false` in Docker, or set both `archestra.codeRuntime.enabled=false` and `archestra.codeRuntime.dagger.managed.enabled=false` in Helm values — the second is what stops the managed Dagger engine pod from being deployed. A manual deployment needs a Dagger runner host in `ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`. Without a reachable runner host, the feature stays off. `ARCHESTRA_CODE_RUNTIME_ENABLED` only controls whether local dev, quickstart, and Helm deploy the embedded Dagger engine. See [Deployment](./platform-deployment#code-sandbox) for the full list.

Running a command needs the `sandbox:execute` permission. See [Access Control](./platform-access-control).

## Use Case: Cleaning a Spreadsheet

An analyst attaches `q3-signups.csv` to a chat and asks the agent to drop duplicate rows and chart signups by week.

- The file lands in the sandbox at `/home/sandbox/attachments/q3-signups.csv` automatically.
- The agent runs Python with pandas to remove duplicates and group the rows by week.
- It writes `signups-by-week.png` and a cleaned `q3-signups-deduped.csv`, then saves both to the Files panel.
- The analyst downloads the chart and the cleaned file straight from the chat.
