---
title: Importing
description: Create and update Knowledge Files from an external pipeline
order: 1
lastUpdated: 2026-10-05
---

Keep Knowledge Files current from your own pipeline: one API call creates or replaces a file and indexes it. Use it for reports a script writes, or pages a connector cannot fetch.

| Call | Does |
| --- | --- |
| `PUT /api/knowledge-files/:fileId/content` | Creates or replaces a file, then indexes it. Use this for repeated imports. |
| `POST /api/knowledge-files` | Stores a new file only |
| `POST /api/knowledge-files/index` | Indexes stored files into a knowledge base |

For repeated imports, make a UUID once for each source document, and reuse it on every import. Replacing keeps the file's permissions and labels. A new file gives its uploader full access, and only that uploader can replace it.

```python
import base64
import os
import requests

# Persist this UUID for this source document. Use a different UUID for each document.
file_id = "ce4b5d70-0bab-4e83-b2cc-8c2d934c7f45"
response = requests.put(
    f"{os.environ['ARCHESTRA_URL']}/api/knowledge-files/{file_id}/content",
    headers={"Authorization": os.environ["ARCHESTRA_API_KEY"]},
    json={
        "filename": "market-report.md",
        "mimeType": "text/markdown",
        "content": base64.b64encode(open("market-report.md", "rb").read()).decode(),
        "knowledgeBaseId": os.environ["KNOWLEDGE_BASE_ID"],
    },
    timeout=120,
)
response.raise_for_status()
for result in response.json()["results"]:
    if result["failures"]:
        raise RuntimeError(result["failures"])
```

Use an API key with [`knowledgeSource:create`](/docs/reference/permissions#knowledgeSource:create) and [`knowledgeSource:update`](/docs/reference/permissions#knowledgeSource:update) permissions. The key's user needs access to the target knowledge base. Replacement also refreshes other knowledge bases already linked to the file. The caller needs access to each linked base.

Check every result's `failures` array, even after an HTTP success. Files remain stored when indexing fails; retry the same request after fixing the cause. Embeddings run asynchronously. Send updates for the same file sequentially. A different file with the same filename in the same directory causes a conflict.

## Example: Market Monitoring

A marketing agent summarizes mentions of a fictional product, Northstar, each week. A connector crawls its configured public sites daily. The agent queries their shared knowledge base through a weekly schedule trigger.

For pages needing custom fetching, an external pipeline imports Markdown reports instead. Include the source URL and capture date in each report. Reuse a file UUID to keep the latest content. Use distinct UUIDs and dated filenames to retain daily snapshots for comparisons. Crawler refreshes update pages; they do not retain daily versions.