---
title: Overview
category: Knowledge
order: 1
description: Built-in RAG Knowledge Base to give your agents access to your data.
lastUpdated: 2026-04-30
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Plug your agents straight into your company's knowledge across Jira, Confluence, GitHub, Notion, SharePoint, Google Drive, Salesforce, and more, so they can answer from your own data.

The full RAG stack (chunking, embedding, hybrid search, reranking) runs inside Archestra. No external vector database or separate retrieval service required.

![Agent answering from a Jira Knowledge Base with cited sources](/docs/assets/automated_screenshots/platform-knowledge-bases_chat-with-citations.webp)

## Configuration

Open **Settings > Knowledge**. Both an embedding and a reranking model must be set before Knowledge Bases and can be used.

### Embedding Configuration

![Embedding Configuration card in Settings > Knowledge](/docs/assets/automated_screenshots/platform-knowledge-bases_embedding-configuration.webp)

Pick the API key and embedding model. The embedding model vectorizes ingested documents so they can be queried semantically. The same model is used for both indexing and querying, which is why it is locked once saved.

- **Key** — only keys whose synced models have configured embedding dimensions appear in this list. If yours is missing, go to **LLM Providers > Models**, sync the provider, and set the dimensions for the embedding model. Supported dimensions: 768, 1536, 3072.
- **Model** — any embedding-capable model exposed by the selected key.

To change the embedding model, click **Drop** to clear the existing index — every document will need to be re-embedded on the next connector sync.

### Reranking Configuration

![Reranking Configuration card in Settings > Knowledge](/docs/assets/automated_screenshots/platform-knowledge-bases_reranking-configuration.webp)

Pick the LLM that scores and reorders search results by relevance.

- **Key** — any LLM provider key.
- **Model** — any chat model from that provider.

### Creating a Knowledge Base

A Knowledge Base is a set of connectors. Create one from the **Knowledge** page and assign connectors to get data from. The same Knowledge Base can be reused across multiple agents and MCP Gateways.

### Creating a Connector

Connectors pull data from external tools (Jira, Confluence, GitHub, etc.) and feed it into one or more Knowledge Bases. Each connector has a visibility setting that controls who can query its data — see [Connector Visibility](/docs/platform-knowledge-connectors#visibility). For supported types and configuration, see [Connectors](/docs/platform-knowledge-connectors).

### Assigning to an Agent

1. Go to **Agents** in the left sidebar and click the agent you want to attach knowledge to (or create a new one).
2. In the **Edit Agent** dialog, scroll to **Knowledge Sources**.
3. Click **Select connectors or knowledge bases** and pick one or more entries from the **Knowledge Bases** and **Connectors** lists. An agent can be assigned multiple Knowledge Bases or individual connectors.
4. Click **Update** to save.

Once assigned, the agent gains a `query_knowledge_sources` tool that searches across everything attached to it and pulls back the most relevant documents to answer the user's question.

![Selecting Knowledge Bases and connectors on an agent](/docs/assets/automated_screenshots/platform-knowledge-bases_assign-to-agent.webp)
