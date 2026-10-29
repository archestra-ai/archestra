import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsAreaAccess } from "@/app/_parts/use-settings-area-access";
import { McpCredentialBlockers } from "./mcp-credential-blockers";

vi.mock("@/app/_parts/use-settings-area-access");

const missingValue = {
  envKey: "GITHUB_TOKEN",
  credentialId: "github",
  credentialName: "GitHub token",
  reason: "not_connected",
} as Parameters<typeof McpCredentialBlockers>[0]["blockers"][number];

describe("McpCredentialBlockers", () => {
  it.each([
    [true, "/settings/credentials"],
    [false, "/account/credentials"],
  ])("sends a reader to their one Credentials page to add a missing value (Settings visible: %s)", (canSeeSettings, href) => {
    vi.mocked(useSettingsAreaAccess).mockReturnValue(canSeeSettings);
    render(<McpCredentialBlockers blockers={[missingValue]} />);
    expect(
      screen.getByRole("link", { name: "Open Credentials" }),
    ).toHaveAttribute("href", href);
  });
});
