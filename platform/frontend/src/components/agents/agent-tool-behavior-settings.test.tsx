import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MISSING_CREDENTIAL_SUMMARY } from "./agent-form.utils";
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

describe("AgentToolBehaviorSettings — missing-connections purpose", () => {
  it("always states what the setting is for, whatever the choice", () => {
    for (const behavior of ["allow", "warn", "block"] as const) {
      const { unmount } = renderSettings({
        missingCredentialBehavior: behavior,
      });

      expect(screen.getByText(MISSING_CREDENTIAL_SUMMARY)).toBeInTheDocument();

      unmount();
    }
  });
});
