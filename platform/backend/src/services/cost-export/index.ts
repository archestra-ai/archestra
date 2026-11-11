import type { CostExportSchedule } from "@archestra/shared";
import { describeBlobProviderError } from "@/blob-providers/blob-provider";
import logger from "@/logging";
import BlobProviderModel from "@/models/blob-provider";
import CostExportModel from "@/models/cost-export";
import OrganizationModel from "@/models/organization";
import { blobProviderService } from "@/services/blob-provider";
import {
  ApiError,
  type CostExport,
  type CostExportRunResult,
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
    const created = await CostExportModel.create({
      organizationId,
      ...data,
      // The first file is the period in progress, once it completes.
      exportedThrough: periodStart(new Date(), data.schedule),
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
  async runNow(params: {
    id: string;
    organizationId: string;
  }): Promise<CostExportRunResult> {
    await this.get(params);
    const result = await this.run(params.id, { rewriteLatest: true });
    if (!result) {
      throw new ApiError(409, "This export is already running");
    }
    if (result.error) throw new ApiError(502, result.error);
    return { files: result.files };
  }

  /** Periodic task: run every enabled export with a due period. */
  async runDue(now = new Date()): Promise<void> {
    for (const costExport of await CostExportModel.findEnabled()) {
      if (duePeriods(costExport, now).length === 0) continue;
      try {
        const result = await this.run(costExport.id, { rewriteLatest: false });
        if (result?.error) {
          logger.warn(
            { costExportId: costExport.id, error: result.error },
            "Cost export run failed",
          );
        }
      } catch (error) {
        logger.error(
          { err: error, costExportId: costExport.id },
          "Cost export run crashed",
        );
      }
    }
  }

  // === internal ===

  /** One run under the export's lease; null when another run holds it. */
  private async run(
    id: string,
    options: { rewriteLatest: boolean },
  ): Promise<(CostExportRunResult & { error: string | null }) | null> {
    const costExport = await CostExportModel.claimRun({
      id,
      leaseSeconds: LEASE_SECONDS,
    });
    if (!costExport) return null;

    const now = new Date();
    const due = duePeriods(costExport, now);
    const periods =
      due.length > 0 || !options.rewriteLatest
        ? due
        : [latestCompletedPeriod(costExport.schedule, now)];
    const files: CostExportRunResult["files"] = [];
    let exportedThrough: Date | undefined;
    let lastObjectKey: string | undefined;
    try {
      const provider = await blobProviderService.resolve({
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
        id,
        status: "success",
        error: null,
        exportedThrough,
        lastObjectKey,
      });
      return { files, error: null };
    } catch (error) {
      const message = describeBlobProviderError(error);
      await CostExportModel.finishRun({
        id,
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
  const { runningUntil: _runningUntil, ...rest } = row;
  return rest;
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
const LEASE_SECONDS = 15 * 60;
