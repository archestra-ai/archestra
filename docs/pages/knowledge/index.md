---
title: Knowledge (RAG)
description: Give agents cited answers from connected sources and uploaded documents
order: 5
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Agents answer from your company's documents, with a link to every source, and each person finds only what they can open. Ask "What is our deployment rollback procedure?", and the agent quotes the runbook in Confluence and links to it.

- Pull from where your documents already live: Confluence, Google Drive, SharePoint, Jira, GitHub, and [more](/docs/knowledge/connectors). Connectors sync on a schedule.
- Or upload files yourself, such as a contract that came by email. See [Knowledge Files](/docs/knowledge/files).
- Each person sees only their documents. Connectors can copy each source's own access rules. See [Who Can Find What](#permissions).
- Use it in any client. Agents, chat, and any MCP client through a [gateway](/docs/mcp/gateway#knowledge) search the same sources.

<span id="knowledge-files"></span><span id="chat-project-and-knowledge-files"></span><span id="example-vendor-security-reviews"></span><span id="importing-files-from-a-pipeline"></span><span id="example-market-monitoring"></span>

<span id="creating-a-knowledge-base"></span>

## Create a Knowledge Base

A Knowledge Base groups the sources an agent searches. First, an admin must set an [embedding model](#embedding-model).

1. Go to **Knowledge → Knowledge Bases** and click **Create Knowledge Base**.
2. Add a [connector](/docs/knowledge/connectors) for each source, or pick [Knowledge Files](/docs/knowledge/files) to index.
3. Wait for the first sync run to finish with indexed documents.
4. Open the agent, go to **Tools & Knowledge**, and pick the base under **Knowledge sources**. Or pick **All** for every source the person can use, in the agent's environment.
5. Ask the agent a question, and open the cited sources to check the answer.

The agent gets [`query_knowledge_sources`](/docs/reference/archestra-mcp-server#query_knowledge_sources) when it can reach a source. One base can serve many agents, and one connector can be in many bases.

<span id="retrieval-pipeline"></span><span id="indexing"></span><span id="querying"></span><span id="citations"></span><span id="context-expansion"></span><span id="multi-granularity-indexing"></span><span id="keyword-search-language"></span><span id="retrieval-and-citations"></span>

## How Answers Find Sources

Search matches both meaning and exact words, so "roll back a deploy" finds a page titled "Release reversal". Archestra combines both result lists, and a [reranker](#search-ranking) can put the best passages first.

- Every result has its document title and link. Built-in chat shows numbered citations and source quotes.
- Quote checks warn, but do not block. Chat flags a quote it cannot find in the source. Open the source when the answer matters.
- Retrieval results count as sensitive. [Guardrails](/docs/agents/guardrails) can then limit the agent's next tool calls.

### Narrowing a Search

Name the space or label in your question, or in the agent's instructions. The search tool can filter on document metadata, such as a Confluence space or labels:

```json
{
  "query": "how do we roll back a deploy?",
  "documentFilter": { "spaceKey": "DEV", "labels": ["release-2.0"] }
}
```

Different keys must all match. Several values for one key match any of them. A filter can only narrow results. It never opens a document the person cannot see.

<span id="configuration"></span>

## Settings

Admins tune search under Settings → Knowledge. Only the embedding model is required.

![Embedding, search ranking, and OCR settings](/docs/automated_screenshots/knowledge_settings.webp)

### Embedding Model

Required. It turns every passage into numbers that search compares.

1. Pick an API key and an embedding model. Subscription sign-ins do not work here.
2. Click **Test connection**, then save.

A model is missing? Sync its provider's models under **LLM Providers → Models**, and set the model's dimensions there. Supported dimensions are 384, 768, 1024, 1408, 1536, and 3072.

After you save, the model is locked, because indexing and search must use the same model. To change it, click **Drop index**. That clears the model and the whole index, and later syncs embed every document again.

### Image Embedding

Standalone images are searchable only when the embedding model accepts images. The model decides which formats work. Other images are skipped. A text-only model can still search scanned PDFs through [Document OCR](#document-ocr).

<span id="query-results-ranking"></span><span id="keyword-ranking"></span><span id="reranking"></span><span id="tuning"></span>

### Search Ranking

A reranker reads the top passages and puts the best answers first. Pick a chat model or a supported Cohere Rerank model, test it, and save. A chat model must return structured JSON. Without a reranker, search still combines meaning and keyword results.

Under **Advanced options**, two keyword settings change the next search, with no reindex:

| Setting | Default | Change it when |
| --- | --- | --- |
| **Term Saturation** | 1.2 | Lower it when long, repetitive text crowds out short answers. |
| **Length Normalization** | 0.75 | Raise it to favor shorter passages. |

### Contextual Retrieval

Finds a passage whose subject is named only elsewhere in the document, such as a step that says "restart it" under a heading that names the service. Archestra writes a short context for each passage and matches on it. The agent still reads the original passage.

Under **Search ranking → Advanced options**, pick **Disabled**, **Per document**, or **Per passage**. Per document costs less. Per passage gives more precise context.

- It needs a chat reranker. Cohere Rerank models cannot write context.
- To apply it to documents already indexed, use **Force Re-sync** on each connector.

### Document OCR

Makes scanned PDFs searchable. A vision model reads each PDF page that has no text layer. OCR does not read standalone image files.

1. Pick an API key and a vision model that accepts PDF input.
2. Click **Test connection**. It sends a test PDF page to the model.
3. Save. The first save resets each connector's checkpoint, so the next sync reads PDFs it skipped before.

- Each page is a model call, and the provider charges for it.
- At most 100 pages per document, by default. Change it with [`ARCHESTRA_KNOWLEDGE_BASE_OCR_MAX_PAGES_PER_DOCUMENT`](/docs/reference/configuration#ARCHESTRA_KNOWLEDGE_BASE_OCR_MAX_PAGES_PER_DOCUMENT). The run details show the pages left unread.
- A self-hosted model is missing? Set its input types under **LLM Providers → Models**.

<span id="sync-runs"></span>

## When Sync Goes Wrong

Open the connector to see each sync run, with its progress, warnings, and errors.

| You see | Do this |
| --- | --- |
| **No documents** on the first run | The source is empty, the connector cannot read it, or a filter leaves nothing. A later run with no changes can still succeed. |
| A sync runs too long | Click **Cancel sync** in its **Actions** column. Documents already indexed stay. The next sync starts from the saved checkpoint. |
| Unchanged documents miss a new setting | Click **Force Re-sync** to index them again. |

<span id="permissions"></span>

## Who Can Find What

A person finds only the documents they may use. Knowledge Bases, connectors, and files each have their own [resource permissions](/docs/admin/access-control#granular-access-control):

- **Can view** lets a person browse it.
- **Can use** also lets a person search it.

Sharing a base does not open its connectors or documents to more people. Permission changes apply at once, with no reindex.

- Copy the source's own rules with [Auto-sync permissions](/docs/knowledge/connectors#auto-sync-permissions). Some sources cannot copy every rule, so check the connector's limits first.
- **Environments:** a connector serves only agents and gateways in its own [environment](/docs/admin/environments). A connector with no environment is in Default.
- Granular access and Auto-sync permissions are Enterprise features. See [Licensing](/docs/get-started#licensing).

<span id="deleting-and-restoring"></span>

## Delete and Restore

A deleted base or connector goes to the Deleted list, where you can restore it.

- **A deleted base** leaves its connectors syncing.
- **A deleted connector** stops syncing and loses its stored credential.

To restore one, set the status filter to **Deleted** and click **Restore**. A restored base is available to its agents again. A restored connector stays off: sign it in again, and turn it on.

Global admins can click **Delete permanently** in the Deleted list. For a base, this removes its agent assignments and keeps its connectors. For a connector, this removes its indexed documents and run history.
