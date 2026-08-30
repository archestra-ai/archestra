import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentExecutionCredentialPrompt } from "./agent-execution-credential-prompt";

const dialog = vi.hoisted(() => vi.fn());

vi.mock("@/components/execution-credential-connection-dialog", () => ({
  ExecutionCredentialConnectionDialog: (props: unknown) => {
    dialog(props);
    return <div role="dialog">Connection dialog</div>;
  },
}));
vi.mock("@/lib/config/config.query", () => ({ useFeature: () => false }));
vi.mock("@/lib/execution-credentials.query", () => ({
  useExecutionCredentials: () => ({
    data: [
      {
        key: "github",
        name: "GitHub PAT",
        description: "Access GitHub repositories",
        icon: "logo:github",
        builtIn: true,
        allowPersonal: true,
        allowOrganization: false,
        personalConfigured: false,
        organizationConfigured: false,
      },
    ],
  }),
}));

describe("AgentExecutionCredentialPrompt", () => {
  it("opens the shared personal connection dialog for a missing reusable credential", async () => {
    const user = userEvent.setup();
    render(
      <AgentExecutionCredentialPrompt
        agentId="agent-1"
        missing={[
          {
            key: "GITHUB_TOKEN",
            credentialId: "github",
            label: "GitHub PAT",
          },
        ]}
        declarations={[
          {
            key: "GITHUB_TOKEN",
            credentialId: "github",
            label: "GitHub PAT",
            scope: "per_user",
            required: true,
          },
        ]}
        onConnected={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "personal" }),
    );
  });
});
