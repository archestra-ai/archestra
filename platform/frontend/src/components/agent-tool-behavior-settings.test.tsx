import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MISSING_CREDENTIAL_SUMMARY,
  TOOL_CONNECTION_PROMPTING,
} from "./agent-form.utils";
import { AgentToolBehaviorSettings } from "./agent-tool-behavior-settings";

type Props = React.ComponentProps<typeof AgentToolBehaviorSettings>;

function renderSettings(overrides: Partial<Props> = {}) {
  const props: Props = {
    progressiveToolLoading: false,
    onProgressiveToolLoadingChange: () => {},
    missingCredentialBehavior: "allow",
    onMissingCredentialBehaviorChange: () => {},
    locked: false,
    toolExposureDocsUrl: "https://example.test/exposure",
    toolConnectionsDocsUrl: "https://example.test/connections",
    ...overrides,
  };
  return render(<AgentToolBehaviorSettings {...props} />);
}

describe("AgentToolBehaviorSettings — missing-connections status", () => {
  // What was reported as unclear: the closed control shows only a terse label
  // ("When a tool needs it") and Radix keeps the menu — where each choice is
  // spelled out — unmounted while the setting is merely being read. So the
  // status has to be stated inline, and it has to say both what the setting is
  // for and what the current choice does.

  it("always states what the setting is for, whatever the choice", () => {
    for (const behavior of ["allow", "warn", "block"] as const) {
      const { unmount } = renderSettings({
        missingCredentialBehavior: behavior,
      });

      expect(screen.getByText(MISSING_CREDENTIAL_SUMMARY)).toBeInTheDocument();

      unmount();
    }
  });

  it("states the selected option's effect without opening the menu", () => {
    for (const behavior of ["allow", "warn", "block"] as const) {
      const { unmount } = renderSettings({
        missingCredentialBehavior: behavior,
      });

      expect(
        screen.getByText(TOOL_CONNECTION_PROMPTING[behavior]),
      ).toBeInTheDocument();

      unmount();
    }
  });

  it("shows the effect of the current choice, not of the other choices", () => {
    renderSettings({ missingCredentialBehavior: "block" });

    expect(
      screen.getByText(TOOL_CONNECTION_PROMPTING.block),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(TOOL_CONNECTION_PROMPTING.allow),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(TOOL_CONNECTION_PROMPTING.warn),
    ).not.toBeInTheDocument();
  });

  it("keeps the purpose summary but reports the pinned effect when locked", () => {
    // All mode pins the behavior and disables the control, so the second line
    // reports what All mode does instead of a per-choice line the reader
    // cannot change — while the purpose summary still stands.
    renderSettings({ locked: true, missingCredentialBehavior: "allow" });

    expect(screen.getByText(MISSING_CREDENTIAL_SUMMARY)).toBeInTheDocument();
    expect(
      screen.getByText(/All mode always asks when a tool needs it\./),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(TOOL_CONNECTION_PROMPTING.allow),
    ).not.toBeInTheDocument();
  });
});
