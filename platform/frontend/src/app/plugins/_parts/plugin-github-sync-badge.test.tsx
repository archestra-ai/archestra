import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginGithubSyncBadge } from "./plugin-github-sync-badge";

function renderBadge(
  overrides: Partial<
    Parameters<typeof PluginGithubSyncBadge>[0]["plugin"]
  > = {},
) {
  render(
    <TooltipProvider>
      <PluginGithubSyncBadge
        plugin={{
          sourceKind: "github",
          githubSyncInterval: null,
          lastSyncedAt: null,
          ...overrides,
        }}
      />
    </TooltipProvider>,
  );
}

describe("PluginGithubSyncBadge", () => {
  it("marks manually checked GitHub imports as synced", async () => {
    const user = userEvent.setup();
    renderBadge();

    await user.hover(screen.getByText("synced"));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Imported from GitHub; updates are checked manually/,
    );
  });

  it("does not mark manually authored plugins as synced", () => {
    renderBadge({ sourceKind: "manual" });

    expect(screen.queryByText("synced")).not.toBeInTheDocument();
  });
});
