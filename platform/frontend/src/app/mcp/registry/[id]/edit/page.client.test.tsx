import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useInternalMcpCatalogItem } from "@/lib/mcp/mcp-registry.query";
import { McpCatalogItemEditPage } from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/app/openappa/_parts/openappa-chat-button", () => ({
  OpenAppaChatButton: ({ children }: { children: React.ReactNode }) => (
    <a href="/coverage-review">{children}</a>
  ),
}));
vi.mock("../../_parts/server-rules-launch", () => ({
  ServerRulesButton: ({ children }: { children: React.ReactNode }) => (
    <a href="/server-rules">{children}</a>
  ),
}));
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));
vi.mock("@/lib/mcp/mcp-registry.query");
vi.mock("@/components/mcp-catalog-icon", () => ({
  McpCatalogIcon: () => <span />,
}));
vi.mock("../../_parts/catalog-setup-wizard", () => ({
  SETUP_STEPS: [
    { id: "configuration", title: "Configuration" },
    { id: "test", title: "Test Connection" },
    { id: "tools", title: "Tools & Guardrails" },
  ],
  SetupStepper: () => <div />,
  TestConnectionStep: () => <div>Connection test</div>,
  ToolsAndGuardrailsStep: () => <div>Tool review</div>,
  useTestConnectionTarget: () => ({ target: { id: "connection-1" } }),
}));
vi.mock("../../_parts/edit-catalog-dialog", () => ({
  EditCatalogContent: () => <div>Configuration form</div>,
}));
vi.mock("../../_parts/idle-hibernation-section", () => ({
  IdleHibernationSection: () => null,
}));

describe("McpCatalogItemEditPage", () => {
  const push = vi.fn();
  const replace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/mcp/registry/server-1/edit");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("step=test") as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useRouter).mockReturnValue({
      push,
      replace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useInternalMcpCatalogItem).mockReturnValue({
      data: {
        id: "server-1",
        name: "filesystem",
        icon: null,
        serverType: "local",
        effectiveActions: ["read", "update"],
      },
      isPending: false,
    } as unknown as ReturnType<typeof useInternalMcpCatalogItem>);
    canReadGuardrails(true);
  });

  function canReadGuardrails(data: boolean) {
    vi.mocked(useHasPermissions).mockReturnValue({
      data,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
  }

  function onToolsStepWithGuardrails() {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("step=tools") as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useFeature).mockImplementation(
      ((name: string) => name === "openappaEnabled") as typeof useFeature,
    );
  }

  it("does not open an app's backing entry for editing", () => {
    vi.mocked(useInternalMcpCatalogItem).mockReturnValue({
      data: { id: "app-backing", name: "app", icon: null, serverType: "app" },
      isPending: false,
    } as unknown as ReturnType<typeof useInternalMcpCatalogItem>);

    render(<McpCatalogItemEditPage id="app-backing" />);

    expect(screen.getByText("Server not found")).toBeInTheDocument();
  });

  it("keeps the Test Connection page in the shared shell and advances to tool review", async () => {
    const user = userEvent.setup();
    render(<McpCatalogItemEditPage id="server-1" />);

    expect(
      screen.getByRole("heading", { name: /edit filesystem/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Connection test")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to server" }),
    ).toHaveAttribute("href", "/mcp/registry/server-1");

    await user.click(
      screen.getByRole("button", { name: "Tools & Guardrails" }),
    );

    expect(replace).toHaveBeenCalledWith(
      "/mcp/registry/server-1/edit?step=tools",
      { scroll: false },
    );
  });

  it("sends a server editor without a Guardrails permission to the server's own rules", () => {
    onToolsStepWithGuardrails();
    canReadGuardrails(false);

    render(<McpCatalogItemEditPage id="server-1" />);

    expect(
      screen.getByRole("link", { name: "Configure Guardrails with agent" }),
    ).toHaveAttribute("href", "/server-rules");
  });

  it("keeps the coverage review for anyone who may read the Guardrails policy", () => {
    onToolsStepWithGuardrails();

    render(<McpCatalogItemEditPage id="server-1" />);

    expect(
      screen.getByRole("link", { name: "Configure Guardrails with agent" }),
    ).toHaveAttribute("href", "/coverage-review");
  });
});
