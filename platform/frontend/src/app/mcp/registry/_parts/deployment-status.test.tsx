import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusBanner,
  DeploymentStatusIndicator,
  type DeploymentStatusSummary,
  getDeploymentDotConfig,
  getDeploymentLabel,
  getDeploymentStatusAriaLabel,
  getDeploymentStatusChipLabel,
  getDeploymentStatusTooltipCopy,
  HIBERNATED_STATUS_DESCRIPTION,
  STATE_PRIORITY,
  WAKING_STATUS_DESCRIPTION,
} from "./deployment-status";

/** A summary in a given overall state, with plausible per-state counts. */
function summaryFor(
  overallState: DeploymentStatusSummary["overallState"],
  counts: Partial<DeploymentStatusSummary> = {},
): DeploymentStatusSummary {
  return {
    total: 3,
    running: 2,
    pending: 0,
    failed: 0,
    hibernated: 0,
    waking: 0,
    overallState,
    ...counts,
  };
}

describe("getDeploymentDotConfig", () => {
  it("returns green non-pulsing dot for running state", () => {
    expect(getDeploymentDotConfig("running")).toEqual({
      dotClass: "bg-green-500",
      pulse: false,
    });
  });
  it("returns yellow pulsing dot for pending state", () => {
    expect(getDeploymentDotConfig("pending")).toEqual({
      dotClass: "bg-yellow-500",
      pulse: true,
    });
  });
  it("returns red non-pulsing dot for failed state", () => {
    expect(getDeploymentDotConfig("failed")).toEqual({
      dotClass: "bg-red-500",
      pulse: false,
    });
  });
  it("returns orange non-pulsing dot for degraded state", () => {
    expect(getDeploymentDotConfig("degraded")).toEqual({
      dotClass: "bg-orange-500",
      pulse: false,
    });
  });
  it("returns muted non-pulsing dot for hibernated state", () => {
    expect(getDeploymentDotConfig("hibernated")).toEqual({
      dotClass: "bg-muted-foreground",
      pulse: false,
    });
  });
  it("returns a muted PULSING dot for waking state — calm like hibernated, not amber like starting", () => {
    expect(getDeploymentDotConfig("waking")).toEqual({
      dotClass: "bg-muted-foreground",
      pulse: true,
    });
  });
});

describe("getDeploymentLabel", () => {
  it("returns 'Running' for running state", () => {
    expect(getDeploymentLabel("running")).toBe("Running");
  });
  it("returns 'Starting' for pending state", () => {
    expect(getDeploymentLabel("pending")).toBe("Starting");
  });
  it("returns 'Failed' for failed state", () => {
    expect(getDeploymentLabel("failed")).toBe("Failed");
  });
  it("returns 'Degraded' for degraded state", () => {
    expect(getDeploymentLabel("degraded")).toBe("Degraded");
  });
  it("returns 'Hibernated' for hibernated state", () => {
    expect(getDeploymentLabel("hibernated")).toBe("Hibernated");
  });
  it("returns 'Waking' for waking state", () => {
    expect(getDeploymentLabel("waking")).toBe("Waking");
  });

  it("explains the waking state with its own copy, distinct from hibernated", () => {
    expect(WAKING_STATUS_DESCRIPTION).not.toBe(HIBERNATED_STATUS_DESCRIPTION);
    expect(WAKING_STATUS_DESCRIPTION).toMatch(/waking/i);
  });
});

describe("getDeploymentStatusChipLabel", () => {
  const hibernated = summaryFor("hibernated", { running: 0, hibernated: 3 });
  const waking = summaryFor("waking", { running: 0, waking: 3 });
  const running = summaryFor("running");

  describe("ratio format (registry card)", () => {
    it("names the hibernated state instead of showing 0/3", () => {
      expect(
        getDeploymentStatusChipLabel({ summary: hibernated, format: "ratio" }),
      ).toBe("Hibernated");
    });
    it("names the waking state with an ellipsis", () => {
      expect(
        getDeploymentStatusChipLabel({ summary: waking, format: "ratio" }),
      ).toBe("Waking…");
    });
    it("shows the running/total ratio for every other state", () => {
      expect(
        getDeploymentStatusChipLabel({ summary: running, format: "ratio" }),
      ).toBe("2/3");
      expect(
        getDeploymentStatusChipLabel({
          summary: summaryFor("degraded", { failed: 1 }),
          format: "ratio",
        }),
      ).toBe("2/3");
    });
  });

  describe("ratio-with-state format (catalog detail page)", () => {
    it("names the hibernated state without appending a count", () => {
      expect(
        getDeploymentStatusChipLabel({
          summary: hibernated,
          format: "ratio-with-state",
        }),
      ).toBe("Hibernated");
    });
    it("names the waking state without appending a count", () => {
      expect(
        getDeploymentStatusChipLabel({
          summary: waking,
          format: "ratio-with-state",
        }),
      ).toBe("Waking…");
    });
    it("appends the lowercased state label for every other state", () => {
      expect(
        getDeploymentStatusChipLabel({
          summary: running,
          format: "ratio-with-state",
        }),
      ).toBe("2/3 running");
      expect(
        getDeploymentStatusChipLabel({
          summary: summaryFor("pending", { running: 2, pending: 1 }),
          format: "ratio-with-state",
        }),
      ).toBe("2/3 starting");
    });
  });

  describe("count-with-state format (server settings sidebar)", () => {
    it("names the hibernated state in the sidebar's lowercase voice", () => {
      expect(
        getDeploymentStatusChipLabel({
          summary: hibernated,
          format: "count-with-state",
        }),
      ).toBe("hibernated");
    });
    it("names the waking state in the sidebar's lowercase voice", () => {
      expect(
        getDeploymentStatusChipLabel({
          summary: waking,
          format: "count-with-state",
        }),
      ).toBe("waking");
    });
    it("shows the running count without a total for every other state", () => {
      expect(
        getDeploymentStatusChipLabel({
          summary: running,
          format: "count-with-state",
        }),
      ).toBe("2 running");
    });
  });
});

describe("getDeploymentStatusAriaLabel", () => {
  it("tells screen-reader users the server is hibernated, not down", () => {
    expect(
      getDeploymentStatusAriaLabel({
        summary: summaryFor("hibernated", { running: 0, hibernated: 3 }),
        serverName: "GitHub",
      }),
    ).toBe("All 3 deployments hibernated for GitHub, view logs");
  });

  it("tells screen-reader users the server is waking from idle", () => {
    expect(
      getDeploymentStatusAriaLabel({
        summary: summaryFor("waking", { running: 0, waking: 3 }),
        serverName: "GitHub",
      }),
    ).toBe("All 3 deployments waking from idle for GitHub, view logs");
  });

  it("falls back to the running count for every other state", () => {
    expect(
      getDeploymentStatusAriaLabel({
        summary: summaryFor("running"),
        serverName: "GitHub",
      }),
    ).toBe("2 of 3 deployments running for GitHub, view logs");
  });
});

describe("getDeploymentStatusTooltipCopy", () => {
  it("explains that a hibernated server wakes automatically", () => {
    expect(getDeploymentStatusTooltipCopy("hibernated")).toBe(
      HIBERNATED_STATUS_DESCRIPTION,
    );
    expect(HIBERNATED_STATUS_DESCRIPTION).toBe(
      "Scaled down after being idle — wakes automatically on next use",
    );
  });

  it("explains that a waking server is nearly ready", () => {
    expect(getDeploymentStatusTooltipCopy("waking")).toBe(
      WAKING_STATUS_DESCRIPTION,
    );
    expect(WAKING_STATUS_DESCRIPTION).toBe(
      "Waking from idle — ready in a few seconds",
    );
  });

  it("returns null for states that need no explanation", () => {
    // null is the signal each surface uses to keep its own count tooltip (or
    // render none at all), so it must never become an empty string.
    expect(getDeploymentStatusTooltipCopy("running")).toBeNull();
    expect(getDeploymentStatusTooltipCopy("pending")).toBeNull();
    expect(getDeploymentStatusTooltipCopy("failed")).toBeNull();
    expect(getDeploymentStatusTooltipCopy("degraded")).toBeNull();
  });
});

describe("STATE_PRIORITY", () => {
  it("ranks waking with pending — both transitional — and above hibernated", () => {
    expect(STATE_PRIORITY.waking).toBe(STATE_PRIORITY.pending);
    expect(STATE_PRIORITY.waking).toBeGreaterThan(STATE_PRIORITY.hibernated);
    expect(STATE_PRIORITY.waking).toBeLessThan(STATE_PRIORITY.failed);
    expect(STATE_PRIORITY.waking).toBeLessThan(STATE_PRIORITY.running);
  });
});

describe("computeDeploymentStatusSummary", () => {
  it("returns null for empty server IDs", () => {
    expect(computeDeploymentStatusSummary([], {})).toBeNull();
  });

  it("returns null when all servers are not_created", () => {
    const statuses = {
      "server-1": {
        state: "not_created" as const,
        message: "Deployment not created",
        error: null,
      },
      "server-2": {
        state: "not_created" as const,
        message: "Deployment not created",
        error: null,
      },
    };
    expect(
      computeDeploymentStatusSummary(["server-1", "server-2"], statuses),
    ).toBeNull();
  });

  it("returns null when server IDs have no matching statuses", () => {
    expect(
      computeDeploymentStatusSummary(["server-1", "server-2"], {}),
    ).toBeNull();
  });

  it("returns running when all deployments are running", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 2,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "running",
    });
  });

  it("treats succeeded as running", () => {
    const statuses = {
      "server-1": {
        state: "succeeded" as const,
        message: "Done",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(["server-1"], statuses);
    expect(result).toEqual({
      total: 1,
      running: 1,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "running",
    });
  });

  it("returns pending when any deployment is pending and none failed", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "pending" as const,
        message: "Starting",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 1,
      pending: 1,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "pending",
    });
  });

  it("returns failed when all active deployments are failed", () => {
    const statuses = {
      "server-1": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
      "server-2": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 0,
      pending: 0,
      failed: 2,
      hibernated: 0,
      waking: 0,
      overallState: "failed",
    });
  });

  it("returns degraded when some running and some failed", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 1,
      pending: 0,
      failed: 1,
      hibernated: 0,
      waking: 0,
      overallState: "degraded",
    });
  });

  it("returns degraded when succeeded and failed mixed", () => {
    const statuses = {
      "server-1": {
        state: "succeeded" as const,
        message: "Done",
        error: null,
      },
      "server-2": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
      "server-3": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2", "server-3"],
      statuses,
    );
    expect(result).toEqual({
      total: 3,
      running: 2,
      pending: 0,
      failed: 1,
      hibernated: 0,
      waking: 0,
      overallState: "degraded",
    });
  });

  it("skips server IDs not present in statuses map", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-missing"],
      statuses,
    );
    expect(result).toEqual({
      total: 1,
      running: 1,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "running",
    });
  });

  it("excludes not_created from total count", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "not_created" as const,
        message: "Not created",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 1,
      running: 1,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "running",
    });
  });

  it("dedupes two entries that share a podName into one", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
        podName: "shared-pod",
      },
      "server-2": {
        state: "running" as const,
        message: "Running",
        error: null,
        podName: "shared-pod",
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 1,
      running: 1,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "running",
    });
  });

  it("counts two entries with distinct podNames separately", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
        podName: "pod-a",
      },
      "server-2": {
        state: "running" as const,
        message: "Running",
        error: null,
        podName: "pod-b",
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 2,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "running",
    });
  });

  it("reports pending overallState when the only deployment is pending", () => {
    const statuses = {
      "server-1": {
        state: "pending" as const,
        message: "Starting",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(["server-1"], statuses);
    expect(result).toEqual({
      total: 1,
      running: 0,
      pending: 1,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "pending",
    });
  });

  it("dedupes multi-tenant rows by deploymentName even before a podName resolves", () => {
    // Fresh-install bug: server-2's pod has not scheduled yet (podName null),
    // but both rows share one deployment, so the count must stay 1.
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
        podName: "pod-x",
        deploymentName: "mcp-mt-shared",
      },
      "server-2": {
        state: "pending" as const,
        message: "Starting",
        error: null,
        deploymentName: "mcp-mt-shared",
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 1,
      running: 1,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "running",
    });
  });

  it("surfaces a failed alias when collapsing rows that share a deploymentName", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
        podName: "pod-x",
        deploymentName: "mcp-mt-shared",
      },
      "server-2": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
        deploymentName: "mcp-mt-shared",
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 1,
      running: 0,
      pending: 0,
      failed: 1,
      hibernated: 0,
      waking: 0,
      overallState: "failed",
    });
  });

  it("returns hibernated when all deployments are hibernated", () => {
    const statuses = {
      "server-1": {
        state: "hibernated" as const,
        message: "Scaled down",
        error: null,
      },
      "server-2": {
        state: "hibernated" as const,
        message: "Scaled down",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 0,
      pending: 0,
      failed: 0,
      hibernated: 2,
      waking: 0,
      overallState: "hibernated",
    });
  });

  it("does not count hibernated as running: a running+hibernated mix shows the running summary", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "hibernated" as const,
        message: "Scaled down",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 1,
      pending: 0,
      failed: 0,
      hibernated: 1,
      waking: 0,
      overallState: "running",
    });
  });

  it("does not count hibernated as failed: a failed+hibernated mix is degraded, not failed", () => {
    const statuses = {
      "server-1": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
      "server-2": {
        state: "hibernated" as const,
        message: "Scaled down",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 0,
      pending: 0,
      failed: 1,
      hibernated: 1,
      waking: 0,
      overallState: "degraded",
    });
  });

  it("surfaces pending over hibernated when a deployment is starting", () => {
    const statuses = {
      "server-1": {
        state: "pending" as const,
        message: "Starting",
        error: null,
      },
      "server-2": {
        state: "hibernated" as const,
        message: "Scaled down",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 0,
      pending: 1,
      failed: 0,
      hibernated: 1,
      waking: 0,
      overallState: "pending",
    });
  });

  it("returns waking when all deployments are waking from idle", () => {
    const statuses = {
      "server-1": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
      "server-2": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 0,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 2,
      overallState: "waking",
    });
  });

  it("returns waking when the only deployment is waking (the single-deployment card)", () => {
    const statuses = {
      "server-1": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(["server-1"], statuses);
    expect(result).toEqual({
      total: 1,
      running: 0,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 1,
      overallState: "waking",
    });
  });

  it("returns waking when only waking and hibernated deployments remain", () => {
    const statuses = {
      "server-1": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
      "server-2": {
        state: "hibernated" as const,
        message: "Scaled down",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 0,
      pending: 0,
      failed: 0,
      hibernated: 1,
      waking: 1,
      overallState: "waking",
    });
  });

  it("does not count waking as running: a running+waking mix shows the running summary", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 1,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 1,
      overallState: "running",
    });
  });

  it("leaves the pending outcome unchanged when a deployment is also waking", () => {
    const statuses = {
      "server-1": {
        state: "pending" as const,
        message: "Starting",
        error: null,
      },
      "server-2": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 0,
      pending: 1,
      failed: 0,
      hibernated: 0,
      waking: 1,
      overallState: "pending",
    });
  });

  it("does not count waking as healthy: a failed+waking mix stays failed, not degraded", () => {
    const statuses = {
      "server-1": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
      "server-2": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 0,
      pending: 0,
      failed: 1,
      hibernated: 0,
      waking: 1,
      overallState: "failed",
    });
  });

  it("keeps the degraded outcome when running, failed and waking are mixed", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
      "server-3": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2", "server-3"],
      statuses,
    );
    expect(result).toEqual({
      total: 3,
      running: 1,
      pending: 0,
      failed: 1,
      hibernated: 0,
      waking: 1,
      overallState: "degraded",
    });
  });

  it("surfaces waking over hibernated when collapsing rows that share a deploymentName", () => {
    const statuses = {
      "server-1": {
        state: "hibernated" as const,
        message: "Scaled down",
        error: null,
        deploymentName: "mcp-mt-shared",
      },
      "server-2": {
        state: "waking" as const,
        message: "Waking",
        error: null,
        podName: "pod-x",
        deploymentName: "mcp-mt-shared",
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 1,
      running: 0,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 1,
      overallState: "waking",
    });
  });

  it("counts entries with distinct deploymentNames separately (single-tenant)", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
        podName: "pod-1",
        deploymentName: "mcp-server-1",
      },
      "server-2": {
        state: "running" as const,
        message: "Running",
        error: null,
        podName: "pod-2",
        deploymentName: "mcp-server-2",
      },
    };
    const result = computeDeploymentStatusSummary(
      ["server-1", "server-2"],
      statuses,
    );
    expect(result).toEqual({
      total: 2,
      running: 2,
      pending: 0,
      failed: 0,
      hibernated: 0,
      waking: 0,
      overallState: "running",
    });
  });
});

describe("DeploymentStatusIndicator", () => {
  it("renders nothing when serverIds is empty", () => {
    const { container } = render(
      <DeploymentStatusIndicator serverIds={[]} deploymentStatuses={{}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when all statuses are not_created", () => {
    const statuses = {
      "server-1": {
        state: "not_created" as const,
        message: "Not created",
        error: null,
      },
    };
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1"]}
        deploymentStatuses={statuses}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when serverIds have no matching statuses", () => {
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1"]}
        deploymentStatuses={{}}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders a green dot for all-running deployments", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
    };
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1", "server-2"]}
        deploymentStatuses={statuses}
      />,
    );
    expect(container.querySelector(".bg-green-500")).toBeInTheDocument();
  });

  it("renders a red dot for all-failed deployments", () => {
    const statuses = {
      "server-1": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
    };
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1"]}
        deploymentStatuses={statuses}
      />,
    );
    expect(container.querySelector(".bg-red-500")).toBeInTheDocument();
  });

  it("renders a yellow pulsing dot for pending deployments", () => {
    const statuses = {
      "server-1": {
        state: "pending" as const,
        message: "Starting",
        error: null,
      },
    };
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1"]}
        deploymentStatuses={statuses}
      />,
    );
    expect(container.querySelector(".bg-yellow-500")).toBeInTheDocument();
    expect(container.querySelector(".animate-ping")).toBeInTheDocument();
  });

  it("renders an orange dot for degraded (mixed running/failed) deployments", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-2": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
    };
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1", "server-2"]}
        deploymentStatuses={statuses}
      />,
    );
    expect(container.querySelector(".bg-orange-500")).toBeInTheDocument();
  });

  it("renders a muted dot for all-hibernated deployments", () => {
    const statuses = {
      "server-1": {
        state: "hibernated" as const,
        message: "Scaled down",
        error: null,
      },
    };
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1"]}
        deploymentStatuses={statuses}
      />,
    );
    expect(container.querySelector(".bg-muted-foreground")).toBeInTheDocument();
    expect(container.querySelector(".bg-green-500")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-red-500")).not.toBeInTheDocument();
  });

  it("renders a muted PULSING dot for waking deployments — never the red/orange error colours", () => {
    const statuses = {
      "server-1": {
        state: "waking" as const,
        message: "Waking",
        error: null,
      },
    };
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1"]}
        deploymentStatuses={statuses}
      />,
    );
    expect(container.querySelector(".bg-muted-foreground")).toBeInTheDocument();
    expect(container.querySelector(".animate-ping")).toBeInTheDocument();
    expect(container.querySelector(".bg-yellow-500")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-red-500")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-orange-500")).not.toBeInTheDocument();
  });

  it("only considers serverIds passed as props, ignores extra statuses", () => {
    const statuses = {
      "server-1": {
        state: "running" as const,
        message: "Running",
        error: null,
      },
      "server-other": {
        state: "failed" as const,
        message: "Error",
        error: "crash",
      },
    };
    const { container } = render(
      <DeploymentStatusIndicator
        serverIds={["server-1"]}
        deploymentStatuses={statuses}
      />,
    );
    // Should show green (running), not degraded, because server-other is not in serverIds
    expect(container.querySelector(".bg-green-500")).toBeInTheDocument();
    expect(container.querySelector(".bg-orange-500")).not.toBeInTheDocument();
  });
});

describe("DeploymentStatusBanner", () => {
  it("renders the Hibernated label with a muted dot for a hibernated deployment", () => {
    const { container, getByText } = render(
      <DeploymentStatusBanner
        status={{
          state: "hibernated" as const,
          message: "Scaled down",
          error: null,
        }}
      />,
    );
    expect(getByText("Hibernated")).toBeInTheDocument();
    expect(container.querySelector(".bg-muted-foreground")).toBeInTheDocument();
  });

  it("renders the Waking label with a muted pulsing dot for a waking deployment", () => {
    const { container, getByText } = render(
      <DeploymentStatusBanner
        status={{
          state: "waking" as const,
          message: "Waking from idle",
          error: null,
        }}
      />,
    );
    expect(getByText("Waking")).toBeInTheDocument();
    expect(container.querySelector(".bg-muted-foreground")).toBeInTheDocument();
    expect(container.querySelector(".animate-ping")).toBeInTheDocument();
  });
});
