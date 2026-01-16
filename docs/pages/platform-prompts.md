---
title: Prompts
category: Archestra Platform
subcategory: Concepts
order: 4
description: Automate chat bootstrapping with reusable prompts
lastUpdated: 2025-11-28
---

<!-- 
Check ../docs_writer_prompt.md before changing this file.
-->

<iframe width="100%" height="400" src="https://www.youtube.com/embed/k_67sbC-ITY" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>

<br />
Prompts are a way to automate the bootstrapping of your chats in Archestra. They allow you to pre-configure the starting state of a conversation, ensuring consistent behavior and context for your AI agents.

![Prompts Library](/docs/automated_screenshots/platform_prompts_library.png)

## Core Concepts

A Prompt consists of:

- **Name**: A friendly name for the prompt.
- **Profile**: The [Profile](/docs/platform-profiles) associated with this prompt. This determines which MCP tools and servers the chat will have access to.
- **System Prompt**: Instructions hidden from the chat but visible to the LLM as the first thing it reads. This defines the persona and behavior of the agent.
- **User Prompt**: The first message automatically sent on behalf of the user when the chat starts.

## Managing Prompts

You can create, edit, and delete prompts from the **New Chat** screen. Archestra supports **versioning**, allowing you to track changes to your prompts over time.

![Create Prompt](/docs/automated_screenshots/platform_prompts_create_modal.png)

### Access Control

"Prompt" is a separate resource in Archestra's Role-Based Access Control (RBAC), giving you granular control over what actions are available for a given role.

- **Predefined Member role**: Can only read prompts (use them to start chats).
- **Admin**: Has full CRUD capabilities (create, read, update, delete).


## Usage

To use a prompt:
1. Go to **New Chat**.
2. Select a prompt from the library.
3. The chat will automatically start with the configured System Prompt and User Prompt.
4. The AI will respond to the initial User Prompt using the tools available to the assigned Profile.

