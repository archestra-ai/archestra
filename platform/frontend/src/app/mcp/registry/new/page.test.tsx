import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverCanAccessPageMock } = vi.hoisted(() => ({
  serverCanAccessPageMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth.server", () => ({
  serverCanAccessPage: serverCanAccessPageMock,
}));

vi.mock("./page.client", () => ({
  default: () => <div data-testid="new-mcp-catalog-item-form" />,
}));

vi.mock("@/components/error-fallback", () => ({
  ServerErrorFallback: ({ error }: { error: Error }) => (
    <div data-testid="server-error-fallback">{error.message}</div>
  ),
}));

import NewMcpCatalogItemPageServer from "./page";

describe("NewMcpCatalogItemPageServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverCanAccessPageMock.mockResolvedValue(true);
  });

  it("refuses the page instead of offering the form when the user cannot create registry entries", async () => {
    serverCanAccessPageMock.mockResolvedValue(false);

    render(await NewMcpCatalogItemPageServer());

    expect(serverCanAccessPageMock).toHaveBeenCalledWith("/mcp/registry/new");
    expect(
      screen.getByText("You don't have permission to access this page."),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("new-mcp-catalog-item-form"),
    ).not.toBeInTheDocument();
  });

  it("renders the form when the user may create registry entries", async () => {
    render(await NewMcpCatalogItemPageServer());

    expect(screen.getByTestId("new-mcp-catalog-item-form")).toBeInTheDocument();
  });

  it("reports a failed permission lookup rather than reading it as a refusal", async () => {
    serverCanAccessPageMock.mockRejectedValue(
      new Error("Permission lookup failed: no response"),
    );

    render(await NewMcpCatalogItemPageServer());

    expect(screen.getByTestId("server-error-fallback")).toHaveTextContent(
      "Permission lookup failed: no response",
    );
  });
});
