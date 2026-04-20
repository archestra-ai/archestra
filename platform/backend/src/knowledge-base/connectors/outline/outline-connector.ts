import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  OutlineCheckpoint,
  OutlineConfig,
} from "@/types";
import { OutlineConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 25;
// Subtract 5 min to guard against clock skew so we never miss a document
// that was edited right around the checkpoint boundary.
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

type OutlineDocument = {
  id: string;
  title: string;
  text: string;
  urlId: string;
  collectionId: string | null;
  parentDocumentId: string | null;
  url?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
};

type OutlineListResponse = {
  ok: boolean;
  data: OutlineDocument[];
  pagination: {
    offset: number;
    limit: number;
    nextPath?: string;
  };
};

type OutlineAuthResponse = {
  ok: boolean;
  data?: {
    user?: { id: string; name: string };
    team?: { id: string; name: string };
  };
};

function buildHeaders(credentials: ConnectorCredentials): HeadersInit {
  return {
    Authorization: `Bearer ${credentials.apiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function parseOutlineConfig(
  config: Record<string, unknown>,
): OutlineConfig | null {
  const parsed = OutlineConfigSchema.safeParse({
    type: "outline",
    ...config,
  });
  return parsed.success ? parsed.data : null;
}

export class OutlineConnector extends BaseConnector {
  type = "outline" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseOutlineConfig(config);
    if (!parsed) {
      return { valid: false, error: "Invalid Outline configuration" };
    }
    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug("Testing Outline connection");

    const parsed = parseOutlineConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Outline configuration" };
    }

    try {
      const response = await this.fetchWithRetry(
        `${parsed.outlineUrl}/api/auth.info`,
        {
          method: "POST",
          headers: buildHeaders(params.credentials),
          body: JSON.stringify({}),
        },
      );

      const body = (await response.json()) as OutlineAuthResponse;

      if (!response.ok || !body.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: Authentication failed`,
        };
      }

      this.log.debug("Outline connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Outline connection test failed");
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
    const parsed = parseOutlineConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Outline configuration");
    }

    const checkpoint = (params.checkpoint as OutlineCheckpoint | null) ?? {
      type: "outline" as const,
    };

    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;

    // Compute the incremental cutoff with a safety buffer to avoid missing
    // documents updated near the checkpoint boundary.
    const syncFrom = checkpoint.lastSyncedAt
      ? new Date(
          new Date(checkpoint.lastSyncedAt).getTime() -
            INCREMENTAL_SAFETY_BUFFER_MS,
        ).toISOString()
      : undefined;

    this.log.debug(
      {
        collectionIds: parsed.collectionIds,
        syncFrom,
        batchSize,
      },
      "Starting Outline sync",
    );

    if (parsed.collectionIds && parsed.collectionIds.length > 0) {
      // Track the max lastSyncedAt across collections so a later collection
      // with no or older docs cannot regress the persisted high-water mark.
      let maxLastSyncedAt: string | undefined = checkpoint.lastSyncedAt;
      let yieldedAny = false;
      for (const collectionId of parsed.collectionIds) {
        const batchGen = this.syncCollection({
          config: parsed,
          credentials: params.credentials,
          collectionId,
          syncFrom,
          batchSize,
          checkpoint,
        });
        for await (const batch of batchGen) {
          yieldedAny = true;
          const batchLastSyncedAt = (batch.checkpoint as OutlineCheckpoint)
            .lastSyncedAt;
          if (
            batchLastSyncedAt &&
            (!maxLastSyncedAt || batchLastSyncedAt > maxLastSyncedAt)
          ) {
            maxLastSyncedAt = batchLastSyncedAt;
          }
          yield {
            ...batch,
            checkpoint: buildCheckpoint({
              type: "outline",
              itemUpdatedAt: maxLastSyncedAt,
              previousLastSyncedAt: checkpoint.lastSyncedAt,
            }),
          };
        }
      }
      if (!yieldedAny) {
        yield {
          documents: [],
          checkpoint: buildCheckpoint({
            type: "outline",
            itemUpdatedAt: maxLastSyncedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          failures: this.flushFailures(),
          hasMore: false,
        };
      }
    } else {
      // No collection filter: sync all accessible published documents.
      yield* this.syncCollection({
        config: parsed,
        credentials: params.credentials,
        collectionId: undefined,
        syncFrom,
        batchSize,
        checkpoint,
      });
    }
  }

  private async *syncCollection(params: {
    config: OutlineConfig;
    credentials: ConnectorCredentials;
    collectionId: string | undefined;
    syncFrom: string | undefined;
    batchSize: number;
    checkpoint: OutlineCheckpoint;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      config,
      credentials,
      collectionId,
      syncFrom,
      batchSize,
      checkpoint,
    } = params;

    let offset = 0;
    let hasMore = true;
    let lastSyncedAt: string | undefined = checkpoint.lastSyncedAt;

    while (hasMore) {
      await this.rateLimit();

      const body: Record<string, unknown> = {
        limit: batchSize,
        offset,
        sort: "updatedAt",
        direction: "DESC",
        statusFilter: ["published"],
      };
      if (collectionId) {
        body.collectionId = collectionId;
      }

      const response = await this.fetchWithRetry(
        `${config.outlineUrl}/api/documents.list`,
        {
          method: "POST",
          headers: buildHeaders(credentials),
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Outline API error ${response.status}: ${text.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as OutlineListResponse;

      if (!data.ok || !Array.isArray(data.data)) {
        throw new Error("Unexpected Outline API response format");
      }

      const rawDocs = data.data;

      // For incremental sync, stop processing when we encounter documents
      // older than our cutoff. Since results are sorted by updatedAt DESC,
      // everything after this point is older.
      let stopEarly = false;
      const filteredDocs: OutlineDocument[] = [];
      for (const doc of rawDocs) {
        if (
          syncFrom &&
          doc.updatedAt &&
          new Date(doc.updatedAt) < new Date(syncFrom)
        ) {
          stopEarly = true;
          break;
        }
        filteredDocs.push(doc);
      }

      const documents: ConnectorDocument[] = filteredDocs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        content: doc.text ? `# ${doc.title}\n\n${doc.text}` : `# ${doc.title}`,
        sourceUrl: doc.url ?? buildDocumentUrl(config.outlineUrl, doc.urlId),
        metadata: {
          collectionId: doc.collectionId,
          parentDocumentId: doc.parentDocumentId,
          urlId: doc.urlId,
        },
        updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : undefined,
      }));

      // Update lastSyncedAt to the most recent document in this batch.
      if (filteredDocs.length > 0 && filteredDocs[0].updatedAt) {
        lastSyncedAt = filteredDocs[0].updatedAt;
      }

      const morePagesAvailable =
        rawDocs.length >= batchSize && !stopEarly && !!data.pagination.nextPath;

      offset += batchSize;
      hasMore = morePagesAvailable;

      yield {
        documents,
        checkpoint: buildCheckpoint({
          type: "outline",
          itemUpdatedAt: lastSyncedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        failures: this.flushFailures(),
        hasMore,
      };

      if (stopEarly) break;
    }
  }
}

function buildDocumentUrl(baseUrl: string, urlId: string): string {
  return `${baseUrl}/doc/${urlId}`;
}
