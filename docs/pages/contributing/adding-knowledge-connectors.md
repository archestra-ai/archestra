---
title: Adding Knowledge Connectors
description: Add a connector that syncs an external data source into knowledge bases.
order: 3
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A [knowledge connector](/docs/knowledge/connectors) pulls documents from an external system, such as an issue tracker or a wiki, into a knowledge base on a schedule. Each connector is a backend class with a config schema, a checkpoint schema, and a sync method, plus a few frontend form fields. Paths on this page are relative to `platform/`.

This page uses a fictional connector called `acme`. The Linear connector in `backend/src/knowledge-base/connectors/linear/` is a complete real example. [Pull request #3938](https://github.com/archestra-ai/archestra/pull/3938), which added the Outline connector, shows the full set of files a connector touches.

## Files TypeScript Finds

1. Add the type literal to `USER_SELECTABLE_CONNECTOR_TYPES` in `backend/src/types/knowledge-connector.ts`.
2. Run `pnpm type-check` from `platform/`, and fix each backend error.
3. Run `pnpm codegen`. The frontend reads connector types from the generated API client. Its errors appear only after this step.
4. Run `pnpm type-check` again, and fix each frontend error.

## Config and Checkpoint Schemas

All connector types are in `backend/src/types/knowledge-connector.ts`. The config holds what the user enters when they create the connector. The checkpoint holds the sync cursor. The next run fetches only items changed after it. Both carry the `type` literal:

```typescript
const ACME = z.literal("acme");

export const AcmeConfigSchema = z.object({
  type: ACME,
  acmeBaseUrl: z.string(),
  projectKeys: z.array(z.string()).optional(),
});

export const AcmeCheckpointSchema = z.object({
  type: ACME,
  lastSyncedAt: z.string().optional(),
});
```

Add both schemas to the `ConnectorConfigSchema` and `ConnectorCheckpointSchema` discriminated unions in the same file. A new connector needs no database migration.

## Connector Class

Create `backend/src/knowledge-base/connectors/acme/acme-connector.ts` with a class that extends `BaseConnector`:

- `validateConfig(config)` parses the config with the connector's schema and checks values such as URL format. It returns `{ valid, error? }`.
- `testConnection({ config, credentials })` makes one cheap API call to prove the credentials work. It returns `{ success, error? }`.
- `sync({ config, credentials, checkpoint })` is an async generator. It yields batches of documents, each with an updated checkpoint.
- `estimateTotalItems(...)` is optional. It returns a total item count for the progress bar, or `null`.

The sync loop pages through the source and yields one batch per page:

```typescript
async *sync(params: {
  config: Record<string, unknown>;
  credentials: ConnectorCredentials;
  checkpoint: Record<string, unknown> | null;
}): AsyncGenerator<ConnectorSyncBatch> {
  const config = AcmeConfigSchema.parse({ type: "acme", ...params.config });
  const checkpoint = params.checkpoint as AcmeCheckpoint | null;
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    await this.rateLimit();
    const response = await this.fetchWithRetry(
      `${config.acmeBaseUrl}/items?updated_since=${checkpoint?.lastSyncedAt ?? ""}&page=${page}`,
      { headers: { Authorization: `Bearer ${params.credentials.apiToken}` } },
    );
    const { items, nextPage } = await response.json();
    hasMore = nextPage !== null;
    page += 1;

    yield {
      documents: items.map((item) => ({
        id: item.id,
        title: item.title,
        content: item.body,
        sourceUrl: item.url,
        metadata: { project: item.projectKey },
        updatedAt: new Date(item.updatedAt),
      })),
      failures: this.flushFailures(),
      checkpoint: buildCheckpoint({
        type: "acme",
        itemUpdatedAt: items.at(-1)?.updatedAt,
        previousLastSyncedAt: checkpoint?.lastSyncedAt,
      }),
      hasMore,
    };
  }
}
```

Follow these rules in `sync`:

- Build checkpoints with `buildCheckpoint`. It takes `lastSyncedAt` from the newest item's timestamp, never from the clock. A clock-based cursor skips items that the source API returns late or out of order.
- Expect to be interrupted. The runtime saves the checkpoint after every batch and resumes from it when a run is cut short. If the connector builds its work list once per run, keep its position in that list in the checkpoint. Move the committed cursor only on the final batch. Otherwise a run that keeps hitting its time limit restarts from the beginning and never finishes. The Perforce connector does this with `targetChangelist` and `filesOffset`.
- **Set `hasMore`** to `true` on every batch except the last.
- Return `failures` and `skipped`. Wrap optional per-item fetches in `safeItemFetch`, so one bad item does not fail the batch. Pass `this.flushFailures()` and `this.flushSkipped()` in each batch.

### BaseConnector Helpers

Use these instead of writing your own:

- `fetchWithRetry(url, options)` fetches with a 30-second timeout. It retries 429, 5xx, and network errors with exponential backoff.
- `rateLimit()` waits between API calls, 100 ms by default.
- `safeItemFetch(...)` fetches an optional sub-resource, such as comments. It records a failure instead of throwing.
- `trackSkipped(item)` records an item the connector skips on purpose, such as an unsupported file type.
- `buildBasicAuthHeader(email, token)` builds a `Basic` authorization header.
- `joinUrl(base, path)` joins URL parts without doubled slashes.

When the source publishes an official SDK, use it: the GitHub connector uses `@octokit/rest` and the GitLab connector uses `@gitbeaker/rest`. If you call the API directly anyway, say why in the pull request. To walk a folder tree, implement `FolderTraversalAdapter` and call `traverseFolders` from `backend/src/knowledge-base/connectors/folder-traversal.ts`, as the Dropbox and Google Drive connectors do.

### Permission Sync

[Auto-Sync Permissions](/docs/knowledge/connectors#auto-sync-permissions) mirrors the source's access rules. Each user then retrieves only what they can read in the source. To support it, set `supportsPermissionSync = true` and implement `syncPermissionSnapshot` and `syncGroups`. The Jira, Confluence, GitHub, and Linear connectors are examples. Add the connector to the support table on that docs page.

## Registration

Add a factory to `connectorRegistry` in `backend/src/knowledge-base/connectors/registry.ts`:

```typescript
acme: () => new AcmeConnector(),
```

Add the display name to `CONNECTOR_TYPE_LABELS` in `shared/knowledge-base.ts`:

```typescript
acme: "Acme",
```

## Frontend

1. Create `frontend/src/app/knowledge/knowledge-bases/_parts/acme-config-fields.tsx` with the connector-specific fields. Copy `linear-config-fields.tsx`: the component takes a `react-hook-form` form and a field-name prefix that defaults to `config`.
2. In `connector-dialog-config.tsx` in the same folder, add the connector to `CONNECTOR_OPTIONS` with a one-line description. TypeScript does not require this entry. Without it, the connector never appears in the picker. Then fill in the records TypeScript flags: the URL field, the credential labels and help text, the default config, and the create and edit field components.
3. Add the logo to `frontend/public/icons/` and register it in `connector-icons.tsx`.
4. If a field takes a comma-separated list, convert it to an array in `transform-config-array-fields.ts`.

## User Docs

Add a section for the connector to `docs/pages/knowledge/connectors/index.md`. Cover what it syncs, how authentication works, where the user gets the credentials, which fields are required, and any filters or limits. Document only the options the create and edit dialogs show.

## Testing

Create `backend/src/knowledge-base/connectors/acme/acme-connector.test.ts`. Mock the SDK or HTTP calls with `vi.mock()`, and test each interface method:

- `validateConfig`: a valid config, missing required fields, and a malformed URL.
- `testConnection`: success, an authentication failure, and an invalid config.
- `sync`: one page, several pages, an incremental run from a checkpoint, filters, document metadata, and API errors.

`backend/src/knowledge-base/connectors/jira/jira-connector.test.ts` is a complete example. Run the tests from `platform/` with `pnpm --filter @backend test -- acme-connector`.

To check the connector end to end, start the [development environment](/docs/contributing/developer-quickstart), create a knowledge base, add the connector, and run a sync. The synced documents appear on the connector's page.
