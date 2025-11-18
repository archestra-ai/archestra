---
title: Secure Agent with OpenWebUI
category: Examples
order: 4
---

## Overview

OpenWebUI - one of the most popular clients for LLMs, however it doesn't have built-in mechanisms to prevent data leaks and malicious commands via tool calls. It can be integrated with Archestra, which intercepts malicious tool calls, and prevent untrusted context from influencing the LLM’s behaviour, providing an essential security layer for production deployments.

## Plan

In this guide, we will set up the basics: OpenWebUI + Github tool -> Archestra Platform -> OpenAI. We will then make OpenWebUI read a very _interesting_ issue that could impact the original plan and cause the OpenWebUI Chat to do something you haven't even asked for. Afterwards, we'll connect it to Archestra to see how it prevented such behavior. This illustrates a fundamental problem faced by any AI Agent when it has access to tools that can read private data or post outside, known as the [Lethal Trifecta](https://www.archestra.ai/docs/platform-lethal-trifecta).

## Step 1. Get your LLM Provider API Key

This example uses OpenAI, but Archestra supports multiple LLM providers. See [Supported LLM Providers](https://www.archestra.ai/docs/platform-supported-llm-providers) for the complete list.

For OpenAI, you can get an API key from:

- OpenAI directly ([https://platform.openai.com/account/api-keys](https://platform.openai.com/account/api-keys))
- Azure OpenAI
- Any OpenAI-compatible service (e.g., LocalAI, FastChat, Helicone, LiteLLM, OpenRouter etc.)

👉 Once you have the key, copy it and keep it handy.

## Step 2. Deploy OpenWebUI and Archestra locally with docker compose

1. Export your OpenAI API key from step 1:

   ```bash
   export OPENAI_API_KEY=sk-proj-...
   ```

2. Download the docker compose file to install Archestra platform and sample OpenWebUI locally:

   ```bash
   curl -O https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/docker-compose-openwebui.yaml
   ```

3. Start docker compose if you want to deploy both OpenWebUI and Archestra

   ```bash
   docker compose -f docker-compose-openwebui.yaml up
   ```

4. Alternatively, if you already have OpenWebUI, you can only deploy Archerstra, and configure your existing OpenWebUI in the next step

   ```bash
   docker compose -f docker-compose-openwebui.yaml up platform
   ```

## Step 3. Verify (or setup) your OpenAI and Archestra connection

Once OpenWebUI is running:

1. Go to **localhost:3004** or your OpenWebUI url e.g. [https://openweui.yourcompany.com/](https://openweui.yourcompany.com/)
2. Click on your **User > Admin Panel**.
3. Navigate to **Settings > Connections > OpenAI > Configure** (look for the wrench icon).
4. Verify that you have a correct OpenAI API Key and BASE_URL of Archestra: [http://localhost:9000/v1/openai](http://localhost:9000/v1/openai) in URL, or Add Connection with those values, if you use your own OpenWebUI
   ☝️If you're not sure where is Archestra BASE_URL you can navigate to Archestra settings, in our example it on [http://localhost:3000](http://localhost:3000)

   ✌️️If you're running OpenWebUI in its own Docker container locally, separately from the platform, the `BASE_URL` will have Docker's special hostname, `host.docker.internal` instead of `localhost`. E.g. `http://host.docker.internal:9000/v1/openai`

   **Optional:** To use a specific profile, include the profile ID in the URL: `http://localhost:9000/v1/openai/{profile-id}`. You can create and manage profiles at [http://localhost:3000/profiles](http://localhost:3000/profiles)

   ![openwebui](/docs/platfrom/openwebui-image1.png)

   ![openwebui](/docs/platfrom/openwebui-image2.png)

5. Now you can **Create a New Chat** and start chatting with the models

## Step 4. Add OpenWebUI tool

Add some tools to your openwebui, so LLM can trigger actions and extract information. In this example we will add web_search tool

1. Click on **User > Admin Panel**
2. Navigate to **Functions > Import From Link**
3. Paste [https://openwebui.com/t/constliakos/web_search](https://openwebui.com/t/constliakos/web_search) and Click **Import > Save**
4. Now you can use this tool in Chat Input by enabling it with “+”

## Step 5. Configure OpenWebUI mcp server

Also you can start using MCP servers

1. Click **User > Admin Panel**
2. Navigate to **Settings > External tools > Manage Tool Servers > +**
3. In the dialog window select **Type: MCP Streamable HTTP**
4. Paste your MCP server streamable HTTP URL. This example uses Dungeons and Dragons MCP, which also requires your GitHub personal access token.

   ```
   https://dmcp-server.deno.dev/mcp
   ```

   ![](/docs/platfrom/openwebui-image3.png)

5. Click Save
6. Now you can use this tool in Chat Input by enabling it with “+”, try prompting “Roll 2d4+1”

## Step 6. Observe chat history in Archestra

Archestra proxies every request from yout AI Agent (OpenWebUI in this guide) and records all the details, so you can review them.

1. Open [http://localhost:3000](http://localhost:3000) and navigate to **Chat**
2. In the table with conversations open any of them by clicking on the **Details**

## Step 7. See the tools in Archesta and configure the rules

Every tool call is recorded and you can see all the tools ever used by OpenWebUI in on the Tool page, accessible via [http://localhost:3000](http://localhost:3000)

By default, every tool call result is untrusted, e.g. it can poison the context of your agent with prompt injection by email from stranger, or by sketchy website.

Also by default, if your context was exposed to untrusted information, any subsequent tool call would be blocked by archstra.

This rule might be quite limiting for the agent, but you can additional rules to validate the input (the arguments for the tool calls) and allow the tool call even if the conext is untrusted

![](/docs/platfrom/openwebui-image4.png)

I.e. we can always allow `fetch` to open `[google.com](http://google.com)`, even if the context _might_ have a prompt injection and is untrusted

Also we can add a rule to what to consider as untrusted content. E.g. in Tool Result Policies, if we know that we queried our corporate website, we know that we the result will be trusted, and therefore, tool calling would still be allowed:

![](/docs/platfrom/openwebui-image5.png)

The decision tree for archestra would be:

![](/docs/platfrom/openwebui-image6.png)

## All Set

Now you are safe from Lethal Trifecta type attacks and prompt injections cannot influence your agent.
