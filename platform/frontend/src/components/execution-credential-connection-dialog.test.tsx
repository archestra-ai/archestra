import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExecutionCredentialConnectionDialog } from "./execution-credential-connection-dialog";

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("@/lib/execution-credentials.query", () => ({
  useSetExecutionCredentialConnection: () => ({
    mutate: mocks.mutate,
    isPending: false,
  }),
}));

describe("ExecutionCredentialConnectionDialog", () => {
  it("validates and connects a reusable personal credential", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConnected = vi.fn();
    mocks.mutate.mockImplementation(
      (_input: unknown, options: { onSuccess: () => void }) =>
        options.onSuccess(),
    );

    render(
      <ExecutionCredentialConnectionDialog
        definition={{
          key: "github",
          name: "GitHub PAT",
          description: "Repository access",
          icon: "logo:github",
          builtIn: true,
          allowPersonal: true,
          allowOrganization: false,
          personalConfigured: false,
          organizationConfigured: false,
        }}
        scope="personal"
        onConnected={onConnected}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("Secret value is required")).toBeVisible();
    expect(mocks.mutate).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Secret value"), "test-token");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        key: "github",
        name: "GitHub PAT",
        scope: "personal",
        value: "test-token",
      },
      expect.any(Object),
    );
    expect(onConnected).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
