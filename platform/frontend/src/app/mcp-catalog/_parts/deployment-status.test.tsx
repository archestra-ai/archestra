import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  computeDeploymentStatusSummary,
  DeploymentStatusIndicator,
  getDeploymentDotConfig,
  getDeploymentLabel,
} from "./deployment-status";

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
