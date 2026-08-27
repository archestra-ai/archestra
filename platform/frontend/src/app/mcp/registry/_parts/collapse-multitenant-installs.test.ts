import type { McpDeploymentStatusEntry } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { collapseMultitenantInstalls } from "./collapse-multitenant-installs";

const install = (
  id: string,
  overrides: { canUseCredential?: boolean } = {},
) => ({
  id,
  name: `raw-${id}`,
  ownerEmail: `${id}@example.com`,
  teamDetails: { teamId: "t1", name: "Team" },
  scope: "personal" as const,
  ...overrides,
});

const reporting = (
  ...ids: string[]
): Record<string, McpDeploymentStatusEntry> =>
  Object.fromEntries(
    ids.map((id) => [id, { state: "succeeded", podName: `pod-${id}` }]),
  ) as Record<string, McpDeploymentStatusEntry>;

describe("collapseMultitenantInstalls", () => {
  it("backs the single row with a connection the viewer may use", () => {
    const [row] = collapseMultitenantInstalls({
      installs: [
        install("theirs", { canUseCredential: false }),
        install("mine", { canUseCredential: true }),
      ],
      deploymentStatuses: reporting("theirs", "mine"),
      catalogName: "Shared Catalog",
    });

    expect(row.id).toBe("mine");
    expect(row.name).toBe("Shared Catalog");
  });

  it("prefers a usable connection that reports the shared pod over one that does not", () => {
    const [row] = collapseMultitenantInstalls({
      installs: [
        install("usable-no-pod", { canUseCredential: true }),
        install("theirs-with-pod", { canUseCredential: false }),
        install("usable-with-pod", { canUseCredential: true }),
      ],
      deploymentStatuses: reporting("theirs-with-pod", "usable-with-pod"),
      catalogName: "Shared Catalog",
    });

    expect(row.id).toBe("usable-with-pod");
  });

  it("still reports the pod when no connection is the viewer's", () => {
    const [row] = collapseMultitenantInstalls({
      installs: [
        install("theirs-no-pod", { canUseCredential: false }),
        install("theirs-with-pod", { canUseCredential: false }),
      ],
      deploymentStatuses: reporting("theirs-with-pod"),
      catalogName: "Shared Catalog",
    });

    // Pod diagnostics must keep working for an admin even when the Inspector
    // will refuse the row — the panel falls back to whichever install reports
    // the shared deployment.
    expect(row.id).toBe("theirs-with-pod");
    expect(row.canUseCredential).toBe(false);
  });

  it("returns nothing when the catalog has no installs", () => {
    expect(
      collapseMultitenantInstalls({
        installs: [],
        deploymentStatuses: {},
        catalogName: "Shared Catalog",
      }),
    ).toEqual([]);
  });
});
