import type { CostExportSchedule } from "@archestra/shared";
import {
  type BlobProvider,
  describeBlobProviderError,
} from "@/blob-providers/blob-provider";
import logger from "@/logging";
import BlobProviderModel from "@/models/blob-provider";
import CostExportModel from "@/models/cost-export";
import OrganizationModel from "@/models/organization";
import { blobProviderService } from "@/services/blob-provider";
import { taskQueueService } from "@/task-queue";
import {
  ApiError,
  type CostExport,
  type CostExportRunResult,
  CostExportRunTaskPayloadSchema,
  type CreateCostExportRequest,
  type PublicCostExport,
  type UpdateCostExportRequest,
} from "@/types";
import { buildFocusCsv } from "./focus";

/**
 * Scheduled exports of LLM cost and usage to a blob provider.
 *
 * Every completed period (an hour or a UTC day, once {@link SETTLE_MS} has
 * passed so requests still in flight at its end are recorded) is written as
 * one FOCUS CSV file at a key derived from the period alone, so a re-run
 * overwrites the same file instead of duplicating spend. The export's
 * watermark only moves past a period once its file is written; a failed tick
 * is retried by the next one.
 *
 * Runs happen on the task queue, never in a request: a run claims the
 * export's lease, then a `cost_export_run` task does the writing under that
 * claim. Due exports run in parallel; one export never runs twice at once.
 */
class CostExportService {
  async list(organizationId: string): Promise<PublicCostExport[]> {
    const rows = await CostExportModel.findByOrganization(organizationId);
    return rows.map(toPublic);
  }

  async create(params: {
    organizationId: string;
    data: CreateCostExportRequest;
  }): Promise<PublicCostExport> {
    const { organizationId, data } = params;
    await this.requireBlobProvider({
      id: data.blobProviderId,
      organizationId,
    });
    const { startFrom, ...fields } = data;
    const start = startFrom ? new Date(startFrom) : new Date();
    if (start.getTime() > Date.now()) {
      throw new ApiError(400, "Start date can't be in the future");
    }
    const created = await CostExportModel.create({
      organizationId,
      ...fields,
      // Every period from the start on is due once it completes; a past start
      // is a backfill, written oldest first.
      exportedThrough: periodStart(start, data.schedule),
    });
    return this.get({ id: created.id, organizationId });
  }

  async get(params: {
    id: string;
    organizationId: string;
  }): Promise<PublicCostExport> {
    const row = await CostExportModel.findById(params);
    if (!row) throw new ApiError(404, "Cost export not found");
    return toPublic(row);
  }

  async update(params: {
    id: string;
    organizationId: string;
    data: UpdateCostExportRequest;
  }): Promise<PublicCostExport> {
    const { id, organizationId, data } = params;
    await this.get({ id, organizationId });
    if (data.blobProviderId) {
      await this.requireBlobProvider({
        id: data.blobProviderId,
        organizationId,
      });
    }
    // The watermark stays put on a schedule change: a daily export that
    // takes over mid-day writes the rest of that day as hourly files first
    // (see duePeriods), so no hour is written twice or skipped.
    await CostExportModel.update({ id, organizationId }, data);
    return this.get({ id, organizationId });
  }

  async delete(params: { id: string; organizationId: string }): Promise<void> {
    if (!(await CostExportModel.delete(params))) {
      throw new ApiError(404, "Cost export not found");
    }
  }

  /**
   * Write every due period now. With nothing due, write the most recent
   * completed period again, so "run now" always proves the pipeline.
   */
  /**
   * Queue a run now: write every due period, or rewrite the latest completed
   * one when none is due. 409 when a run is already queued or in progress.
   */
  async runNow(params: {
    id: string;
    organizationId: string;
  }): Promise<PublicCostExport> {
    await this.get(params);
    const claimed = await CostExportModel.claimRun({
      id: params.id,
      leaseSeconds: LEASE_SECONDS,
    });
    if (!claimed) {
      throw new ApiError(409, "This export is already running");
    }
    await this.enqueueRun({ costExport: claimed, rewriteLatest: true });
    return this.get(params);
  }

  /** Periodic task: queue a run of every enabled export with a due period. */
  async runDue(now = new Date()): Promise<void> {
    for (const costExport of await CostExportModel.findEnabled()) {
      if (duePeriods(costExport, now).length === 0) continue;
      // A failing destination is retried less often the longer it fails.
      const retryAt = nextRetryAt(costExport);
      if (retryAt && retryAt > now) continue;
      try {
        const claimed = await CostExportModel.claimRun({
          id: costExport.id,
          leaseSeconds: LEASE_SECONDS,
        });
        // Already queued or running: that run writes the due periods.
        if (!claimed) continue;
        await this.enqueueRun({ costExport: claimed, rewriteLatest: false });
      } catch (error) {
        logger.error(
          { err: error, costExportId: costExport.id },
          "Could not queue a cost export run",
        );
      }
    }
  }

  /** A queued run (`cost_export_run` task), under the claim it was queued with. */
  async runQueued(payload: unknown): Promise<void> {
    const { costExportId, claimedUntil, rewriteLatest } =
      CostExportRunTaskPayloadSchema.parse(payload);
    const costExport = await CostExportModel.resumeRun({
      id: costExportId,
      claimedUntil: new Date(claimedUntil),
      leaseSeconds: LEASE_SECONDS,
    });
    if (!costExport) {
      logger.info(
        { costExportId },
        "Cost export run skipped: its claim expired or the export is gone",
      );
      return;
    }
    const result = await this.write(costExport, { rewriteLatest });
    if (result.error) {
      logger.warn(
        { costExportId, error: result.error },
        "Cost export run failed",
      );
      return;
    }
    await this.continueCatchUp(costExportId);
  }

  // === internal ===

  /**
   * A run writes at most {@link MAX_PERIODS_PER_RUN} periods. When more are
   * due (a backfill, or catching up after an outage), queue the next run
   * right away instead of waiting for the next tick.
   */
  private async continueCatchUp(costExportId: string): Promise<void> {
    const after = await CostExportModel.findEnabledById(costExportId);
    if (!after || duePeriods(after, new Date()).length === 0) return;
    const claimed = await CostExportModel.claimRun({
      id: costExportId,
      leaseSeconds: LEASE_SECONDS,
    });
    if (!claimed) return;
    try {
      await this.enqueueRun({ costExport: claimed, rewriteLatest: false });
    } catch (error) {
      // The next tick picks it up.
      logger.warn(
        { err: error, costExportId },
        "Could not queue the next catch-up run",
      );
    }
  }

  /** Queue a run for a claim; gives the claim back if queueing fails. */
  private async enqueueRun(params: {
    costExport: CostExport & { runningUntil: Date };
    rewriteLatest: boolean;
  }): Promise<void> {
    const { costExport, rewriteLatest } = params;
    try {
      await taskQueueService.enqueue({
        taskType: "cost_export_run",
        payload: {
          costExportId: costExport.id,
          claimedUntil: costExport.runningUntil.toISOString(),
          rewriteLatest,
        },
        // A failed write is recorded on the export and retried by the next
        // tick; a crashed run's lease expires and the tick queues it again.
        maxAttempts: 1,
      });
    } catch (error) {
      await CostExportModel.releaseRun({
        id: costExport.id,
        claimedUntil: costExport.runningUntil,
      });
      throw error;
    }
  }

  /** Write the run's periods; the caller holds the lease. */
  private async write(
    costExport: CostExport,
    options: { rewriteLatest: boolean },
  ): Promise<CostExportRunResult & { error: string | null }> {
    const now = new Date();
    const due = duePeriods(costExport, now);
    const periods =
      due.length > 0 || !options.rewriteLatest
        ? due
        : [latestCompletedPeriod(costExport.schedule, now)];
    const files: CostExportRunResult["files"] = [];
    let exportedThrough: Date | undefined;
    let lastObjectKey: string | undefined;
    let provider: BlobProvider | undefined;
    try {
      provider = await blobProviderService.resolve({
        id: costExport.blobProviderId,
        organizationId: costExport.organizationId,
      });
      const organization = await OrganizationModel.getById(
        costExport.organizationId,
      );
      for (const period of periods) {
        const rows = await CostExportModel.usageForPeriod({
          organizationId: costExport.organizationId,
          start: period.start,
          end: period.end,
        });
        const written = await provider.put({
          key: objectKey(costExport, period),
          body: buildFocusCsv({
            organization: {
              id: costExport.organizationId,
              name: organization?.name ?? costExport.organizationId,
            },
            rows,
          }),
          contentType: "text/csv; charset=utf-8",
        });
        files.push({
          key: written.key,
          location: written.location,
          rows: rows.length,
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
        });
        lastObjectKey = written.key;
        if (period.end > costExport.exportedThrough) {
          exportedThrough = period.end;
        }
      }
      await CostExportModel.finishRun({
        id: costExport.id,
        status: "success",
        error: null,
        exportedThrough,
        lastObjectKey,
      });
      return { files, error: null };
    } catch (error) {
      // The provider's own explanation, as its connection test shows it.
      const message = provider
        ? provider.describeError(error)
        : describeBlobProviderError(error);
      await CostExportModel.finishRun({
        id: costExport.id,
        status: "failed",
        error: message,
        exportedThrough,
        lastObjectKey,
      });
      return { files, error: message };
    }
  }

  private async requireBlobProvider(params: {
    id: string;
    organizationId: string;
  }): Promise<void> {
    if (!(await BlobProviderModel.findById(params))) {
      throw new ApiError(400, "Blob provider not found");
    }
  }
}

export const costExportService = new CostExportService();

// === internal ===

/** `hourly` names the file by its hour (and covers one hour). */
type Period = { start: Date; end: Date; hourly: boolean };

function toPublic(
  row: CostExport & { blobProviderName: string },
): PublicCostExport {
  const { runningUntil, consecutiveFailures: _failures, ...rest } = row;
  return {
    ...rest,
    running: runningUntil !== null && runningUntil.getTime() > Date.now(),
    nextRetryAt: nextRetryAt(row),
  };
}

/**
 * When a failing export is next retried by the scheduler: 5 minutes after
 * its first failure, doubling up to an hour. Null unless the last run failed.
 */
function nextRetryAt(
  costExport: Pick<
    CostExport,
    "lastRunStatus" | "lastRunAt" | "consecutiveFailures"
  >,
): Date | null {
  if (costExport.lastRunStatus !== "failed" || !costExport.lastRunAt) {
    return null;
  }
  const failures = Math.max(costExport.consecutiveFailures, 1);
  const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
  return new Date(costExport.lastRunAt.getTime() + delay);
}

/** Completed, settled periods after the watermark, oldest first. */
function duePeriods(
  costExport: Pick<CostExport, "exportedThrough" | "schedule">,
  now: Date,
): Period[] {
  const periods: Period[] = [];
  let start = periodStart(costExport.exportedThrough, "hourly");
  while (periods.length < MAX_PERIODS_PER_RUN) {
    // A watermark inside a day (after a switch from hourly) finishes that
    // day hour by hour, then continues with whole days.
    const hourly =
      costExport.schedule === "hourly" ||
      start.getTime() !== periodStart(start, "daily").getTime();
    const granularity = hourly ? "hourly" : "daily";
    const end = periodEnd(start, granularity);
    if (end > latestCompletedPeriod(granularity, now).end) break;
    periods.push({ start, end, hourly });
    start = end;
  }
  return periods;
}

function latestCompletedPeriod(
  schedule: CostExportSchedule,
  now: Date,
): Period {
  const end = periodStart(new Date(now.getTime() - SETTLE_MS), schedule);
  const start = periodStart(new Date(end.getTime() - 1), schedule);
  return { start, end, hourly: schedule === "hourly" };
}

function periodStart(at: Date, schedule: CostExportSchedule): Date {
  const start = new Date(at);
  start.setUTCMinutes(0, 0, 0);
  if (schedule === "daily") start.setUTCHours(0);
  return start;
}

function periodEnd(start: Date, schedule: CostExportSchedule): Date {
  return new Date(start.getTime() + (schedule === "daily" ? DAY_MS : HOUR_MS));
}

/**
 * `<prefix>/year=YYYY/month=MM/day=DD/archestra-focus-<period>.csv`: Hive-style
 * partitions, so query engines (Athena, BigQuery external tables, DuckDB) can
 * prune by date.
 */
function objectKey(
  costExport: Pick<CostExport, "pathPrefix">,
  period: Period,
): string {
  const iso = period.start.toISOString();
  const [year, month, day] = iso.slice(0, 10).split("-");
  const label = period.hourly ? iso.slice(0, 13) : iso.slice(0, 10);
  const partition = `year=${year}/month=${month}/day=${day}`;
  const file = `archestra-focus-${label}.csv`;
  return [costExport.pathPrefix, partition, file].filter(Boolean).join("/");
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How long after a period ends before it is exported. */
const SETTLE_MS = 15 * 60 * 1000;
/** Catch-up cap per run; the next tick continues. */
const MAX_PERIODS_PER_RUN = 48;
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const LEASE_SECONDS = 15 * 60;
