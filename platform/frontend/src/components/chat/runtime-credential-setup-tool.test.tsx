import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RuntimeCredentialSetupTool } from "./runtime-credential-setup-tool";

vi.mock("@/lib/runtime-credentials.query", () => ({
  useRuntimeCredentials: () => ({
    data: [{ id: "new-app", name: "GitHub App", key: "github-app" }],
  }),
}));
vi.mock("@/components/settings/runtime-credential-definition-dialog", () => ({
  RuntimeCredentialDefinitionDialog: ({
    onCreated,
  }: {
    onCreated: (id: string) => void;
  }) => (
    <button type="button" onClick={() => onCreated("new-app")}>
      Create GitHub App
    </button>
  ),
}));
vi.mock("@/components/runtime-credential-connection-dialog", () => ({
  RuntimeCredentialConnectionDialog: ({
    onConnected,
  }: {
    onConnected: () => void;
  }) => (
    <button type="button" onClick={onConnected}>
      Connect private key
    </button>
  ),
}));

beforeEach(() => sessionStorage.clear());

it("opens credential setup from a completed tool call and resumes chat after connection", () => {
  const onSendMessage = vi.fn();
  const view = render(
    <RuntimeCredentialSetupTool
      ready
      toolCallId="call-1"
      onSendMessage={onSendMessage}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create GitHub App" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect private key" }));
  expect(onSendMessage).toHaveBeenCalledWith(
    expect.stringContaining("GitHub App"),
  );

  view.unmount();
  render(<RuntimeCredentialSetupTool ready toolCallId="call-1" />);
  expect(
    screen.queryByRole("button", { name: "Create GitHub App" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Connect GitHub App" }));
  expect(
    screen.getByRole("button", { name: "Create GitHub App" }),
  ).toBeTruthy();
});
