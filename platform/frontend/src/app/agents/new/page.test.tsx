import type { Resource } from "@archestra/shared";
import { memberPermissions } from "@archestra/shared/access-control";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverHasPermissionsMock } = vi.hoisted(() => ({
  serverHasPermissionsMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth.server", () => ({
  serverHasPermissions: serverHasPermissionsMock,
}));

vi.mock("@/components/agent-pages/agent-create-page", () => ({
  AgentCreatePage: ({ canCreateAgent }: { canCreateAgent: boolean }) => (
    <div
      data-testid="agent-create-page"
      data-can-create-agent={String(canCreateAgent)}
    />
  ),
}));

vi.mock("@/components/error-fallback", () => ({
  ServerErrorFallback: ({ error }: { error: Error }) => (
    <div data-testid="server-error-fallback">{error.message}</div>
  ),
}));

import NewAgentPageServer from "./page";

describe("NewAgentPageServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the chooser with every choice enabled for a default member", async () => {
    // A member creates agents and connects external ones, but does not manage
    // organization settings.
    serverHasPermissionsMock.mockImplementation(
      (permissions: Record<string, readonly string[]>) =>
        Promise.resolve(
          Object.entries(permissions).every(([resource, actions]) =>
            actions.every((action) =>
              (
                memberPermissions[resource as Resource] as readonly string[]
              ).includes(action),
            ),
          ),
        ),
    );

    render(await NewAgentPageServer());

    expect(screen.getByTestId("agent-create-page")).toHaveAttribute(
      "data-can-create-agent",
      "true",
    );
  });

  it("refuses the page without Agent create permission", async () => {
    serverHasPermissionsMock.mockResolvedValue(false);

    render(await NewAgentPageServer());

    expect(
      screen.getByText("You don't have permission to access this page."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("agent-create-page")).not.toBeInTheDocument();
  });

  it("reports a failed permission lookup instead of treating it as a denial", async () => {
    serverHasPermissionsMock.mockRejectedValue(
      new Error("Permission lookup failed: no response"),
    );

    render(await NewAgentPageServer());

    expect(screen.getByTestId("server-error-fallback")).toHaveTextContent(
      "Permission lookup failed: no response",
    );
  });
});
