---
title: Custom Images
description: Run your own coding agent image in Agent Runtime
order: 3
alpha: "Agent Runtime is in Alpha and requires the [Agent Sandbox controller](/docs/agents/runtime/setup#cluster-prerequisites)."
lastUpdated: 2026-10-12
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Run any coding agent in [Agent Runtime](/docs/agents/runtime), not only the built-in ones. Bring a container image with your agent in it. Archestra supplies the rest:

- **The task** and every follow-up.
- **Models** through the LLM Proxy, and **tools and skills** through the MCP Gateway.
- **Persistent storage** and the **live terminal**.

## Use Your Image

1. In the agent's **Runtime** picker, pick **Custom image**.
2. Set **Image**, and set **Command** to your agent's executable and arguments.
3. Set **Inference API** to the protocol your agent speaks: Anthropic Messages, OpenAI Responses, or OpenAI Chat Completions.
4. Start a run.

Your agent reaches models through the supplied LLM Proxy URL and virtual key, and tools and skills through the supplied MCP Gateway.

## What the Image Needs

| Requirement | What to Provide |
| --- | --- |
| Shell and terminal | `/bin/sh` and `tmux` on `PATH`. |
| Output | Progress and results on stdout or stderr. Never print credentials. |
| Exit code | `0` on success, non-zero on failure. |
| Storage | Working files and saved sessions under `/home/node`. Other paths may not survive a pause. |

For the full contract and working examples, see the [image contract](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/runtime-contract.md) and the [maintained images](https://github.com/archestra-ai/archestra/blob/main/platform/agent_images/README.md).

## Add a Toolchain

Extend your agent's current image to install a compiler such as Go while keeping its coding agent and runtime setup.

Save this as `Dockerfile`:

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends golang-go \
 && rm -rf /var/lib/apt/lists/*
USER 1000:1000
```

1. Build the image, replacing the base image with the value in your agent's **Image** field:

   ```bash
   docker build --build-arg BASE_IMAGE=<current-agent-image> -t <registry>/claude-code-go:v1 .
   docker push <registry>/claude-code-go:v1
   ```

2. Set the agent's **Image** to your published image. Keep its existing **Command** and **Inference API**.
3. Start a new run and ask the agent to run `go version`, then compile your project.

What to know:

- This example uses the Debian-based built-in image and Debian's packaged Go version. Install the version your project requires if it differs.
- The Kubernetes cluster must be able to pull your published image.
- Supply repository tokens through the agent's [environment settings](/docs/agents/runtime#clone-a-private-github-repository), rather than including them in the image.

## Send the Run Headers

Send four headers on every request to the LLM Proxy and the MCP Gateway. They tie each model call and tool call to its run, so its logs group together and its [Guardrails](/docs/agents/guardrails) restrictions carry across follow-ups.

| Header | Value | What It Does |
| --- | --- | --- |
| `X-Archestra-Run-Id` | `ARCHESTRA_AGENT_RUNTIME_TASK_ID` | Groups one turn's model calls and tool calls in the logs. |
| `X-Archestra-Session-Id` | `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID` | Groups the whole conversation, follow-ups included. |
| `X-Appa-Session-ID` | `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID` | Names the Guardrails session that holds the conversation's restrictions. |
| `X-Archestra-Runtime-Binding` | `ARCHESTRA_AGENT_RUNTIME_BINDING` | Proves which run sent the request. With Guardrails on, the LLM Proxy rejects a model request without it. |

Each value is an environment variable that Archestra sets in the container.

- **Maintained images:** an image built on a maintained image sends all four when it runs that image's launcher. Keep the base tag current, because a launcher sends only the headers its version knows.
- **Every turn:** the binding is new for each turn, and Archestra starts your command again for each turn. Set the header from the variable on every start, not once per container. A copy saved from an earlier turn is rejected.
- **A credential:** send the binding only to the supplied LLM Proxy and MCP Gateway. Never print it, and never pass it to a model provider or a tool.

## Troubleshooting

Each of these is an HTTP 400 on a model request while Guardrails are on.

| Message | Fix |
| --- | --- |
| `This run's image did not send the X-Archestra-Runtime-Binding header that Guardrails require.` | Send the run headers, or rebuild the image on a current maintained image. Then start a new run. |
| `OpenAPPA runtime binding does not match this run` | The binding is from an earlier turn, or it was changed. Read the variable every time your command starts. |
| `OpenAPPA session does not match the authenticated runtime workspace` | Set `X-Appa-Session-ID` to `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID`. |

