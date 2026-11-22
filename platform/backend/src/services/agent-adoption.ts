import { LRUCacheManager } from "@/cache-manager";
import { ConnectedClientModel } from "@/models";
import type { AgentAdoption } from "@/types";

/** How long a report is reused: the page shows calls, not a live feed. */
const REPORT_TTL_MS = 30_000;
const MAX_REPORTS = 64;

/**
 * The Adoption page's report, kept for a short while. The page reads its
 * summary and pages through its members list over one report, so each new
 * page, sort or search reuses it instead of reading the traffic again, and
 * requests that arrive together share one computation.
 */
class AgentAdoptionReports {
  private readonly reports = new LRUCacheManager<Promise<AgentAdoption>>({
    maxSize: MAX_REPORTS,
    defaultTtl: REPORT_TTL_MS,
  });

  /**
   * The report for one organization and range. `range` is the range as asked
   * for, so requests for "the last 30 days" or "until now" share a report
   * while now moves on; `window` is that range resolved.
   */
  get(params: {
    organizationId: string;
    range: { startDate?: string; endDate?: string };
    window: { since: Date; until: Date };
  }): Promise<AgentAdoption> {
    const { organizationId, range, window } = params;
    const key = [
      organizationId,
      range.startDate ?? "default",
      range.endDate ?? "now",
    ].join("|");
    const cached = this.reports.get(key);
    if (cached) return cached;
    const report = ConnectedClientModel.getAdoption({ organizationId, window });
    this.reports.set(key, report);
    // A failed read is not kept: the next request tries again.
    report.catch(() => this.reports.delete(key));
    return report;
  }
}

export const agentAdoptionReports = new AgentAdoptionReports();
