"use client";

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getServerApiHeadersMock,
  getInternalMcpCatalogMock,
  getMcpServersMock,
} = vi.hoisted(() => ({
  getServerApiHeadersMock: vi.fn(),
  getInternalMcpCatalogMock: vi.fn(),
  getMcpServersMock: vi.fn(),
}));
const { serverCanAccessPageMock } = vi.hoisted(() => ({
  serverCanAccessPageMock: vi.fn(),
}));

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getInternalMcpCatalog: getInternalMcpCatalogMock,
    getMcpServers: getMcpServersMock,
  },
}));

vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: getServerApiHeadersMock,
}));

vi.mock("@/lib/auth/auth.server", () => ({
  serverCanAccessPage: serverCanAccessPageMock,
}));

vi.mock("./page.client", () => ({
  default: ({ initialData }: { initialData: unknown }) => (
    <div data-testid="mcp-registry-page">{JSON.stringify(initialData)}</div>
  ),
}));

vi.mock("@/components/error-fallback", () => ({
  ServerErrorFallback: ({ error }: { error: Error }) => (
    <div data-testid="server-error-fallback">{error.message}</div>
  ),
}));

import McpRegistryPage from "./page";

describe("McpRegistryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerApiHeadersMock.mockResolvedValue({});
    serverCanAccessPageMock.mockResolvedValue(true);
  });

  it("renders the forbidden page before fetching data when access is denied", async () => {
    serverCanAccessPageMock.mockResolvedValue(false);

    render(await McpRegistryPage());

    expect(
      screen.getByText("You don't have permission to access this page."),
    ).toBeInTheDocument();
    expect(getInternalMcpCatalogMock).not.toHaveBeenCalled();
    expect(getMcpServersMock).not.toHaveBeenCalled();
  });

  it("renders the page client when data loads successfully", async () => {
    getInternalMcpCatalogMock.mockResolvedValue({ data: [] });
    getMcpServersMock.mockResolvedValue({ data: [] });

    render(await McpRegistryPage());

    expect(screen.getByTestId("mcp-registry-page")).toBeInTheDocument();
  });
});
