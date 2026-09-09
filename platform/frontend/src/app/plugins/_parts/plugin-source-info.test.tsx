import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PluginSourceInfo } from "./plugin-source-info";

describe("PluginSourceInfo", () => {
  it("reveals sync, file count, and the update date on hover", async () => {
    const user = userEvent.setup();
    renderInfo();

    expect(screen.queryByText("13 files")).not.toBeInTheDocument();
    await user.hover(
      screen.getByRole("button", { name: "GitHub source details" }),
    );

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "Imported from GitHub; updates are checked manually.",
    );
    expect(tooltip).toHaveTextContent("Last checked: not yet.");
    expect(tooltip).toHaveTextContent("13 files");
    expect(tooltip).toHaveTextContent(/Last updated: Aug 23, 2026/);
    expect(tooltip).not.toHaveTextContent("Update available");
  });

  it("exposes a pending update and scheduled sync through keyboard focus", async () => {
    const user = userEvent.setup();
    renderInfo({ pendingSourceSha: "new-commit", githubSyncInterval: "1h" });

    await user.tab();

    expect(
      screen.getByRole("button", { name: "GitHub source: update available" }),
    ).toHaveFocus();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Synced every hour from GitHub");
    expect(tooltip).toHaveTextContent(
      "Update available. A new source commit is waiting for review",
    );
    expect(tooltip).toHaveTextContent("example/policy-plugin");
  });

  it("keeps file metadata available for manually authored plugins", async () => {
    const user = userEvent.setup();
    renderInfo({ sourceKind: "manual", fileCount: 1 });

    await user.hover(
      screen.getByRole("button", { name: "Manual source details" }),
    );

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Manually authored plugin.");
    expect(tooltip).toHaveTextContent("1 file");
    expect(tooltip).not.toHaveTextContent("1 files");
    expect(tooltip).not.toHaveTextContent("GitHub");
  });
});

function renderInfo(
  overrides: Partial<Parameters<typeof PluginSourceInfo>[0]["plugin"]> = {},
) {
  render(
    <PluginSourceInfo
      plugin={{
        sourceKind: "github",
        sourceRepo: "example/policy-plugin",
        sourceMarketplaceRepo: null,
        githubSyncInterval: null,
        lastSyncedAt: null,
        pendingSourceSha: null,
        fileCount: 13,
        updatedAt: "2026-08-23T18:00:00.000Z",
        ...overrides,
      }}
    />,
  );
}
