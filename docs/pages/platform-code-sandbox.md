---
title: Code Sandbox
category: Agents
order: 5
description: A private Linux container where an agent runs code during a chat
lastUpdated: 2026-07-05
---

The code sandbox is a private Linux container where an agent runs code during a chat. It runs shell commands and Python, isolated from your own infrastructure — no host access, and no network beyond what the agent's [environment](./platform-environments) allows. Each conversation gets its own sandbox, created the first time the agent runs something.

## Running Commands

The agent runs shell commands with the `run_command` tool. Files a command writes stay on disk for the next command, so the agent builds up work across several steps. The working directory is `/home/sandbox`.

Python runs in a ready-made project at `/home/sandbox`. The `python3` interpreter has numpy, pandas, and httpx already installed. The agent installs more packages with `uv add <package>` — `pip` is turned off on purpose. Pin versions when a result has to be reproducible, since a later install can resolve to a newer release.

## Files

Files you attach to a chat land in the sandbox automatically, under `/home/sandbox/attachments/`. The agent works with them without any extra step from you.

When the agent produces a file — a cleaned dataset or a chart, for example — it saves the file to the conversation's Files panel, where you can download it. Attachments above the size limit are skipped, and the agent is told which ones.

## Skills

When the agent loads a [skill](./platform-agent-skills), the skill's files mount at `/skills/<name>`, so any scripts it bundles run in the sandbox. The skill's Python modules import directly, with no path setup.

## Limits

Each command runs under fixed caps: 30 seconds of CPU, 1 GiB of memory, and 120 seconds of wall-clock time. Command output is captured up to 256 KiB, and a file the agent exports can be up to 16 MiB. A very long chain of commands eventually reaches a history limit — the agent then starts a fresh sandbox. Admins can tune the caps; see [Deployment](./platform-deployment#code-sandbox).

## Enabling the Sandbox

The sandbox is an admin feature, off by default. It needs two settings: `ARCHESTRA_CODE_RUNTIME_ENABLED=true` and a Dagger runner host in `ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`. Without a reachable runner host, the feature stays off. See [Deployment](./platform-deployment#code-sandbox) for the full list.

Running a command needs the `sandbox:execute` permission. See [Access Control](./platform-access-control).

## Use Case: Cleaning a Spreadsheet

An analyst attaches `q3-signups.csv` to a chat and asks the agent to drop duplicate rows and chart signups by week.

- The file lands in the sandbox at `/home/sandbox/attachments/q3-signups.csv` automatically.
- The agent runs Python with pandas to remove duplicates and group the rows by week.
- It writes `signups-by-week.png` and a cleaned `q3-signups-deduped.csv`, then saves both to the Files panel.
- The analyst downloads the chart and the cleaned file straight from the chat.
