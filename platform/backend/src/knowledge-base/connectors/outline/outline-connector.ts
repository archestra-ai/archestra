import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorItemFailure,
  ConnectorSyncBatch,
  OutlineCheckpoint,
  OutlineConfig,
} from "@/types";
import { OutlineConfigSchema } from "@/types";
import { BaseConnector, extractErrorMessage } from "../base-connector";

const DEFAULT_BATCH_SIZE = 25;

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

// Sentinel collectionId used when the user did not configure a collection
// filter. Lets us use the same resume-bookmark machinery for the full-workspace
// sweep without branching all over the place.
const ALL_COLLECTIONS_SENTINEL = "__all__";

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

    // syncFrom anchors "what counts as new this run." It is the previous
    // successful run's syncStart (promoted to lastSyncedAt on completion).
    // Any document edited at or before this instant is skipped.
    const syncFrom = checkpoint.lastSyncedAt;

    // syncStart anchors "what counts as new *next* run." We persist it to the
    // checkpoint the moment the sweep begins; if a run is interrupted and
    // resumed, we reuse the persisted syncStart so the eventual lastSyncedAt
    // still covers edits that landed between the original start and any
    // resume. Only overwritten (to a fresh timestamp) on a fully fresh run.
    // The clamp guards against a clock regression (NTP skew, container host
    // change) that would otherwise let a promotion to lastSyncedAt slip below
    // the previous successful run's cutoff.
    const syncStartCandidate = checkpoint.syncStart ?? new Date().toISOString();
    const syncStart =
      checkpoint.lastSyncedAt && checkpoint.lastSyncedAt > syncStartCandidate
        ? checkpoint.lastSyncedAt
        : syncStartCandidate;

    const configuredCollectionIds =
      parsed.collectionIds && parsed.collectionIds.length > 0
        ? parsed.collectionIds
        : null;

    // Unify the collection-filter and no-filter paths: the no-filter sweep is
    // a single "virtual collection" identified by ALL_COLLECTIONS_SENTINEL.
    const sweepCollectionIds = configuredCollectionIds ?? [
      ALL_COLLECTIONS_SENTINEL,
    ];

    // Resume: if lastCollectionId is still in the configured list, pick up
    // from there. If the config changed and the bookmark is stale, restart
    // from the beginning — correct at the cost of re-scanning. We still reuse
    // the persisted syncStart so the sweep's sync window is preserved.
    let startIdx = 0;
    if (checkpoint.lastCollectionId) {
      const idx = sweepCollectionIds.indexOf(checkpoint.lastCollectionId);
      if (idx >= 0) startIdx = idx;
    }

    this.log.debug(
      {
        collectionIds: configuredCollectionIds,
        syncFrom,
        syncStart,
        batchSize,
        startIdx,
        resumeFromDocumentId: checkpoint.lastDocumentId,
      },
      "Starting Outline sync",
    );

    let yieldedAny = false;

    for (let i = startIdx; i < sweepCollectionIds.length; i++) {
      const collectionId = sweepCollectionIds[i];
      const isLastCollection = i === sweepCollectionIds.length - 1;

      // Only apply the document-level resume bookmark to the collection that
      // was actively being scanned when the previous run stopped.
      const resumeFromDocumentId =
        i === startIdx && collectionId === checkpoint.lastCollectionId
          ? checkpoint.lastDocumentId
          : undefined;

      for await (const batch of this.syncCollection({
        config: parsed,
        credentials: params.credentials,
        collectionId:
          collectionId === ALL_COLLECTIONS_SENTINEL ? undefined : collectionId,
        syncFrom,
        batchSize,
        resumeFromDocumentId,
      })) {
        yieldedAny = true;
        const isFinalSweepBatch = isLastCollection && !batch.hasMore;
        // The sweep's hasMore spans every collection, not just the current
        // one, so the runner does not treat an intermediate collection's last
        // page as "done."
        const sweepHasMore = batch.hasMore || !isLastCollection;

        yield {
          documents: batch.documents,
          failures: batch.failures,
          checkpoint: isFinalSweepBatch
            ? {
                type: "outline" as const,
                // Successful completion: promote syncStart to lastSyncedAt,
                // drop the transient resume fields so the next fresh run
                // picks up cleanly.
                lastSyncedAt: syncStart,
              }
            : {
                type: "outline" as const,
                syncStart,
                lastCollectionId: collectionId,
                lastDocumentId: batch.lastDocumentId,
                // Keep the previous successful lastSyncedAt. The sync runner
                // persists every yielded checkpoint; advancing lastSyncedAt
                // mid-sweep would let a follow-up run filter out edits that
                // landed in not-yet-visited collections.
                lastSyncedAt: checkpoint.lastSyncedAt,
              },
          hasMore: sweepHasMore,
        };
      }
    }

    // Covers two edge cases: startIdx past the end of the (possibly shrunk)
    // collection list, or a resuming sweep whose bookmarked collection is the
    // last one and the final batch already yielded. Either way, emit a
    // terminal batch so the runner can persist the completed checkpoint.
    if (!yieldedAny) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: {
          type: "outline" as const,
          lastSyncedAt: syncStart,
        },
        hasMore: false,
      };
    }
  }

  private async *syncCollection(params: {
    config: OutlineConfig;
    credentials: ConnectorCredentials;
    collectionId: string | undefined;
    syncFrom: string | undefined;
    batchSize: number;
    resumeFromDocumentId: string | undefined;
  }): AsyncGenerator<{
    documents: ConnectorDocument[];
    failures: ConnectorItemFailure[];
    hasMore: boolean;
    lastDocumentId: string | undefined;
  }> {
    const {
      config,
      credentials,
      collectionId,
      syncFrom,
      batchSize,
      resumeFromDocumentId,
    } = params;

    let offset = 0;
    let hasMore = true;
    // pastResumePoint is false while we walk past already-observed docs on
    // resume; it flips to true once we see the bookmark (or on the fallback
    // retry). When it is false we suppress yields, because those pages
    // represent re-scanning, not new progress.
    let pastResumePoint = !resumeFromDocumentId;
    // Allows exactly one retry if the bookmark doc was deleted between runs;
    // without this guard the skip phase would drain the collection silently
    // and drop any docs edited in the (prev-run → current-run) window.
    let bookmarkRetryDone = !resumeFromDocumentId;
    let lastDocumentId: string | undefined = resumeFromDocumentId;

    const syncFromDate = syncFrom ? new Date(syncFrom) : null;

    while (hasMore) {
      await this.rateLimit();

      // createdAt ASC gives stable iteration under concurrent writes:
      // Outline's document order by creation time is immutable, so offset
      // pagination does not shift already-visited positions when a doc is
      // edited mid-sweep. New docs created mid-sweep append to the tail and
      // are reached on later pages.
      const body: Record<string, unknown> = {
        limit: batchSize,
        offset,
        sort: "createdAt",
        direction: "ASC",
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
      const documents: ConnectorDocument[] = [];

      for (const doc of rawDocs) {
        // Resume skip: walk past the bookmark (and the bookmark doc itself),
        // then start processing. If we never find the bookmark on this
        // collection, the retry branch below resets state and re-scans
        // without the skip so no post-bookmark doc is silently dropped.
        if (!pastResumePoint) {
          if (doc.id === resumeFromDocumentId) {
            pastResumePoint = true;
          }
          continue;
        }

        // Advance the resume bookmark even if the doc is filtered out, so a
        // follow-up run does not need to re-scan already-inspected items.
        lastDocumentId = doc.id;

        // No server-side updatedAt filter is available, so filter client-side.
        // Docs whose updatedAt is at or before the last successful run's
        // syncStart were fully captured by that run and are skipped here.
        if (
          syncFromDate &&
          doc.updatedAt &&
          new Date(doc.updatedAt) <= syncFromDate
        ) {
          continue;
        }

        documents.push({
          id: doc.id,
          title: doc.title,
          content: doc.text
            ? `# ${doc.title}\n\n${doc.text}`
            : `# ${doc.title}`,
          sourceUrl: doc.url ?? buildDocumentUrl(config.outlineUrl, doc.urlId),
          metadata: {
            collectionId: doc.collectionId,
            parentDocumentId: doc.parentDocumentId,
            urlId: doc.urlId,
          },
          updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : undefined,
        });
      }

      const morePagesAvailable =
        rawDocs.length >= batchSize && !!data.pagination.nextPath;

      // Bookmark-missing retry: we drained the collection without ever seeing
      // resumeFromDocumentId, which means the bookmark was deleted from
      // Outline between runs. Restart the collection from offset=0 with the
      // skip disabled so docs that followed the bookmark are not dropped.
      // bookmarkRetryDone prevents a second retry if the collection remains
      // empty on the rescan.
      if (!pastResumePoint && !morePagesAvailable && !bookmarkRetryDone) {
        this.log.warn(
          { resumeFromDocumentId, collectionId },
          "Outline resume bookmark missing; re-scanning collection to avoid silently dropping post-bookmark documents",
        );
        bookmarkRetryDone = true;
        pastResumePoint = true;
        offset = 0;
        lastDocumentId = undefined;
        hasMore = true;
        continue;
      }

      offset += batchSize;
      hasMore = morePagesAvailable;

      // Skip-phase pages re-traverse already-observed docs and carry no new
      // progress; suppress the yield so the runner does not persist redundant
      // checkpoints.
      if (!pastResumePoint) {
        continue;
      }

      yield {
        documents,
        failures: this.flushFailures(),
        hasMore,
        lastDocumentId,
      };
    }
  }
}

function buildDocumentUrl(baseUrl: string, urlId: string): string {
  return `${baseUrl}/doc/${urlId}`;
}
