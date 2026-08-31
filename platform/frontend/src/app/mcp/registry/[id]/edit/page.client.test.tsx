import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { McpCatalogItemEditPage } from "./page.client";

vi.mock("next/navigation");
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));
vi.mock("@/lib/mcp/internal-mcp-catalog.query");
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
    vi.mocked(useInternalMcpCatalog).mockReturnValue({
      data: [
        {
          id: "server-1",
          name: "filesystem",
          icon: null,
          serverType: "local",
        },
      ],
      isPending: false,
    } as unknown as ReturnType<typeof useInternalMcpCatalog>);
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
});
