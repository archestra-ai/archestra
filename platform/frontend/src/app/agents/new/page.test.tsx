import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverHasPermissionsMock } = vi.hoisted(() => ({
  serverHasPermissionsMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth.server", () => ({
  serverHasPermissions: serverHasPermissionsMock,
}));

vi.mock("@/components/agent-pages/agent-create-page", () => ({
  AgentCreatePage: ({
    canAddExternalAgent,
    canCreateAgent,
  }: {
    canAddExternalAgent: boolean;
    canCreateAgent: boolean;
  }) => (
    <div
      data-testid="agent-create-page"
      data-can-add-external-agent={String(canAddExternalAgent)}
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

function mockCapabilities({
  canAddExternalAgent,
  canCreateAgent,
}: {
  canAddExternalAgent: boolean;
  canCreateAgent: boolean;
}) {
  serverHasPermissionsMock.mockImplementation(
    (permissions: Record<string, readonly string[]>) => {
      if (permissions.agent?.includes("create")) {
        return Promise.resolve(canCreateAgent);
      }
      return Promise.resolve(canAddExternalAgent);
    },
  );
}

describe("NewAgentPageServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      persona: "a regular Agent creator",
      canCreateAgent: true,
      canAddExternalAgent: false,
    },
    {
      persona: "an external-agent manager",
      canCreateAgent: false,
      canAddExternalAgent: true,
    },
    {
      persona: "a user with both capability bundles",
      canCreateAgent: true,
      canAddExternalAgent: true,
    },
  ])("opens the chooser for $persona", async (capabilities) => {
    mockCapabilities(capabilities);

    render(await NewAgentPageServer());

    expect(screen.getByTestId("agent-create-page")).toHaveAttribute(
      "data-can-create-agent",
      String(capabilities.canCreateAgent),
    );
    expect(screen.getByTestId("agent-create-page")).toHaveAttribute(
      "data-can-add-external-agent",
      String(capabilities.canAddExternalAgent),
    );
    expect(serverHasPermissionsMock).toHaveBeenCalledWith({
      agent: ["create"],
    });
    expect(serverHasPermissionsMock).toHaveBeenCalledWith({
      agent: ["read"],
      agentSettings: ["update"],
    });
  });

  it("preserves access for a create-only role without Agent read permission", async () => {
    mockCapabilities({
      canCreateAgent: true,
      canAddExternalAgent: false,
    });

    render(await NewAgentPageServer());

    expect(screen.getByTestId("agent-create-page")).toHaveAttribute(
      "data-can-create-agent",
      "true",
    );
  });

  it("refuses the page when neither capability bundle is available", async () => {
    mockCapabilities({
      canCreateAgent: false,
      canAddExternalAgent: false,
    });

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
