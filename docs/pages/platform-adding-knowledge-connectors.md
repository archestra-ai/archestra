---
title: Adding Knowledge Connectors
category: Development
order: 3
description: Developer guide for implementing new Knowledge Base connectors in Archestra Platform
lastUpdated: 2026-04-15
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This is a development guide for adding new Knowledge Base connectors to Archestra.
-->

## Overview

This guide covers how to add a new Knowledge Connector to Archestra Platform. Connectors pull data from external tools (Jira, Confluence, GitHub, GitLab, etc.) into Knowledge Bases on a schedule. Each connector requires:

1. **Zod schemas** for config, checkpoint, and the `type` literal
2. **Connector class** extending `BaseConnector` with `validateConfig`, `testConnection`, and `sync`
3. **Registry entry** so the runtime can instantiate the connector by type string
4. **Frontend config fields** component for the creation dialog
5. **User-facing docs update** in `docs/pages/platform-knowledge-connectors.md`

When the external service provides an official SDK, prefer it over building a client from scratch with raw `fetch` calls. Use a hand-rolled client only when there is no suitable official SDK or the official SDK is clearly incompatible with the connector's requirements. Official SDKs usually handle pagination, authentication, rate limiting, and type safety out of the box. For example, the GitHub connector uses [`@octokit/rest`](https://www.npmjs.com/package/@octokit/rest) and the GitLab connector uses [`@gitbeaker/rest`](https://www.npmjs.com/package/@gitbeaker/rest).

The walkthrough below uses a hypothetical connector as an example.

### Getting Started: Let TypeScript Guide You

Add your connector type literal to `ConnectorTypeSchema` in `backend/src/types/knowledge-connector.ts` and run `pnpm type-check`. TypeScript will report errors in the registry, discriminated unions, and frontend switch statements -- these are exactly the files you need to update.

## Type Definitions

All connector types live in a single file: `backend/src/types/knowledge-connector.ts`. The type system uses Zod discriminated unions keyed on a `type` field.

### 1. Add the type literal

```typescript
const GITHUB = z.literal("github");
```

Add it to the union:

```typescript
export const ConnectorTypeSchema = z.union([JIRA, CONFLUENCE, GITHUB]);
```

### 2. Define config and checkpoint schemas

Config holds the settings a user provides when creating the connector. Checkpoint holds the sync cursor so only new data is fetched on subsequent runs.

```typescript
export const GithubConfigSchema = z.object({
  type: GITHUB,
  githubBaseUrl: z.string(),
  owner: z.string(),
  repo: z.string().optional(),
  labelsToSkip: z.array(z.string()).optional(),
});
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

export const GithubCheckpointSchema = z.object({
  type: GITHUB,
  lastSyncedAt: z.string().optional(),
  lastIssueNumber: z.number().optional(),
});
export type GithubCheckpoint = z.infer<typeof GithubCheckpointSchema>;
```

### 3. Add to discriminated unions

```typescript
export const ConnectorConfigSchema = z.discriminatedUnion("type", [
  JiraConfigSchema,
  ConfluenceConfigSchema,
  GithubConfigSchema, // <-- add here
]);

export const ConnectorCheckpointSchema = z.discriminatedUnion("type", [
  JiraCheckpointSchema,
  ConfluenceCheckpointSchema,
  GithubCheckpointSchema, // <-- add here
]);
```

No changes needed to `ConnectorDocument`, `ConnectorSyncBatch`, or the `Connector` interface -- they are connector-agnostic.

## Connector Implementation

Create a new directory `backend/src/knowledge-base/connectors/github/` with a `github-connector.ts` file.

### The Connector interface

Every connector must implement four methods:

| Method                                                  | Purpose                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `validateConfig(config)`                                | Parse raw config with the Zod schema, run domain-specific checks (e.g., URL format). Return `{ valid, error? }` |
| `testConnection({ config, credentials })`               | Make a lightweight API call to verify credentials work. Return `{ success, error? }`                            |
| `estimateTotalItems({ config, credentials, checkpoint })` | Return an estimated total item count for progress display, or `null` if unknown. The base class returns `null` by default — override to enable progress tracking. |
| `sync({ config, credentials, checkpoint })`             | Async generator that yields `ConnectorSyncBatch` objects, each containing documents and an updated checkpoint   |

### Example implementation

```typescript
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GithubCheckpoint,
  GithubConfig,
} from "@/types/knowledge-connector";
import { GithubConfigSchema } from "@/types/knowledge-connector";
import { BaseConnector } from "../base-connector";

const BATCH_SIZE = 50;

export class GithubConnector extends BaseConnector {
  type = "github" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = GithubConfigSchema.safeParse({ type: "github", ...config });
    if (!parsed.success) {
      return { valid: false, error: "Invalid GitHub configuration" };
    }
    if (!/^https?:\/\/.+/.test(parsed.data.githubBaseUrl)) {
      return {
        valid: false,
        error: "githubBaseUrl must be a valid HTTP(S) URL",
      };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    // Make a lightweight API call to verify credentials
    try {
      const response = await this.fetchWithRetry(
        "https://api.github.com/user",
        {
          headers: {
            Authorization: `Bearer ${params.credentials.apiToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        },
      );
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = GithubConfigSchema.safeParse({
      type: "github",
      ...params.config,
    });
    if (!parsed.success) {
      throw new Error("Invalid GitHub configuration");
    }
    const config = parsed.data;
    const checkpoint = (params.checkpoint as GithubCheckpoint | null) ?? {
      type: "github" as const,
    };

    let page = 1;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();

      const url = `${config.githubBaseUrl}/repos/${config.owner}/${config.repo}/issues?page=${page}&per_page=${BATCH_SIZE}&state=all&sort=updated&direction=asc`;
      const response = await this.fetchWithRetry(url, {
        headers: {
          Authorization: `Bearer ${params.credentials.apiToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });

      const issues = await response.json();
      const documents: ConnectorDocument[] = issues.map((issue: any) => ({
        id: String(issue.number),
        title: issue.title,
        content: `# ${issue.title}\n\n${issue.body ?? ""}`,
        sourceUrl: issue.html_url,
        metadata: { number: issue.number, state: issue.state },
        updatedAt: new Date(issue.updated_at),
      }));

      hasMore = issues.length >= BATCH_SIZE;
      page++;

      yield {
        documents,
        checkpoint: {
          type: "github",
          lastSyncedAt: new Date().toISOString(),
          lastIssueNumber:
            issues.length > 0
              ? issues[issues.length - 1].number
              : checkpoint.lastIssueNumber,
        },
        hasMore,
      };
    }
  }
}
```

### BaseConnector utilities

`BaseConnector` provides helpers you should use rather than reimplementing:

| Method                                      | Purpose                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `fetchWithRetry(url, options, maxRetries?)` | Fetch with exponential backoff, automatic timeout (30s), and retry on 429/5xx or network errors |
| `rateLimit()`                               | Sleep for the configured delay (default 100ms) between API calls to avoid rate limits           |
| `joinUrl(base, path)`                       | Normalize and join URL parts                                                                    |
| `buildBasicAuthHeader(email, token)`        | Build a `Basic` auth header                                                                     |

### SDK selection note

Before writing connector API code, check whether the upstream system publishes an official SDK. If it does, prefer that SDK unless there is a concrete reason not to. If you decide not to use the official SDK, document the reason in the PR so reviewers can evaluate the tradeoff.

### The async generator pattern

The `sync` method is an `AsyncGenerator<ConnectorSyncBatch>`. Each `yield` emits a batch of documents plus an updated checkpoint. The runtime persists the checkpoint after each batch, so if a sync is interrupted, it resumes from the last successful batch.

Key points:

- Call `await this.rateLimit()` before each API call
- Set `hasMore: true` on intermediate batches, `false` on the final one
- Always include the `type` field in the checkpoint object
- The checkpoint is opaque to the runtime; only your connector reads it

## Connector Registry

Register the connector in `backend/src/knowledge-base/connectors/registry.ts`:

```typescript
import { GithubConnector } from "./github/github-connector";

const connectorRegistry: Record<ConnectorType, () => Connector> = {
  jira: () => new JiraConnector(),
  confluence: () => new ConfluenceConnector(),
  github: () => new GithubConnector(), // <-- add here
};
```

The `Record<ConnectorType, ...>` type ensures TypeScript will error if you add a new type to the union but forget to register a factory.

## Frontend Config Fields

Create `frontend/src/app/knowledge-bases/_parts/github-config-fields.tsx`. This component renders form fields for the connector-specific config. It receives a `react-hook-form` `UseFormReturn` and an optional field name prefix (defaults to `"config"`).

```tsx
"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

interface GithubConfigFieldsProps {
  form: UseFormReturn<any>;
  prefix?: string;
}

export function GithubConfigFields({
  form,
  prefix = "config",
}: GithubConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`${prefix}.githubBaseUrl`}
        rules={{ required: "Base URL is required" }}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Base URL</FormLabel>
            <FormControl>
              <Input placeholder="https://api.github.com" {...field} />
            </FormControl>
            <FormDescription>
              GitHub API base URL. Use https://api.github.com for GitHub.com.
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      {/* Add fields for owner, repo, etc. */}
    </div>
  );
}
```

### Wire into the create connector dialog

In `frontend/src/app/knowledge-bases/_parts/create-connector-dialog.tsx`:

1. Import the new config fields component.
2. Add a `<SelectItem>` for the new connector type.
3. Add a conditional render for the config step.

```tsx
import { GithubConfigFields } from "./github-config-fields";

// In the SelectContent:
<SelectItem value="github">GitHub</SelectItem>;

// In the config step:
{
  step === 1 && connectorType === "github" && (
    <GithubConfigFields form={form} />
  );
}
```

Update the `CreateConnectorFormValues` type to include the new connector type in the `connectorType` union.

## Subfolder Traversal

If your connector needs to traverse a folder hierarchy recursively, use the shared `traverseFolders` utility at `platform/backend/src/knowledge-base/connectors/folder-traversal.ts` rather than implementing your own BFS logic.

Implement the `FolderTraversalAdapter` interface with a `listDirectSubfolders` method for your service, then pass it to `traverseFolders`. It handles BFS ordering, depth limiting via `maxDepth`, and skips branches that fail without aborting the sync. See the Dropbox and Google Drive connectors for reference.

## User-Facing Docs

When you add a new connector, you must also add or update the matching section in `docs/pages/platform-knowledge-connectors.md`.

That section should cover the actual setup and operating model for users, not just raw config fields:

- what the connector syncs
- how authentication works
- where the required credentials come from
- which fields are required vs optional
- any important filters, defaults, or limitations
- any connector-specific permissions or admin-consent requirements

Only document options users can actually configure in the create/edit dialogs. Do not document internal schema fields or defaults that are not exposed in the UI.

## Database Schema

The database schema in `backend/src/database/schemas/knowledge-base-connector.ts` does not need changes when adding a new connector. The `config` and `checkpoint` columns use `jsonb` typed with the discriminated union types, so any new variant is stored automatically.

If your connector needs a migration (e.g., a new column), follow the standard Drizzle migration workflow described in `CLAUDE.md`.

## Testing

Create a colocated test file next to the connector implementation, for example `backend/src/knowledge-base/connectors/<connector>/<connector>-connector.test.ts`. Mock the external SDK or HTTP calls; test the connector interface methods.

Structure your test file with three `describe` blocks matching the interface:

| Block            | What to test                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateConfig` | Valid config returns `{ valid: true }`, missing required fields return errors, URL format validation                                                              |
| `testConnection` | Successful API response returns `{ success: true }`, auth failures return errors, invalid config returns errors                                                   |
| `sync`           | Single-page results, pagination across multiple pages, incremental sync using checkpoint, label/filter exclusion, document metadata mapping, API errors propagate |

Use `vi.mock()` to mock the external client library. See `backend/src/knowledge-base/connectors/jira/jira-connector.test.ts` for a complete example.
