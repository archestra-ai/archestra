"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select uses Popper and pointer capture APIs that jsdom does not provide.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const mutateAsync = vi.fn();

let mockOrganization: Record<string, unknown> | null = null;
let mockOrganizationPending = false;

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
    isPending: mockOrganizationPending,
  }),
  useAppearanceSettings: () => ({
    data: { appName: null },
  }),
  useUpdateMcpSettings: () => ({
    mutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true, isPending: false }),
  useMissingPermissions: () => [],
}));

import McpSettingsPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <McpSettingsPage />
    </QueryClientProvider>,
  );
}

describe("McpSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrganization = {
      mcpOauthAccessTokenLifetimeSeconds: 31_536_000,
    };
    mockOrganizationPending = false;
    mutateAsync.mockResolvedValue({
      mcpOauthAccessTokenLifetimeSeconds: 604_800,
    });
  });

  it("submits a preset MCP token lifetime", async () => {
    const user = userEvent.setup();

    renderPage();

    const select = screen.getByRole("combobox", { name: /token lifetime/i });
    expect(select).toHaveTextContent("1 year");

    await user.click(select);
    await user.click(screen.getByRole("option", { name: "7 days" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        mcpOauthAccessTokenLifetimeSeconds: 604_800,
      });
    });
  });

  it("submits a custom MCP token lifetime", async () => {
    const user = userEvent.setup();

    renderPage();

    await user.click(screen.getByRole("combobox", { name: /token lifetime/i }));
    await user.click(screen.getByRole("option", { name: "Custom lifetime" }));

    const input = screen.getByLabelText(/custom lifetime in seconds/i);
    await user.clear(input);
    await user.type(input, "123456");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        mcpOauthAccessTokenLifetimeSeconds: 123_456,
      });
    });
  });

  it("shows the default preset when the organization response is missing the lifetime", () => {
    mockOrganization = {};

    renderPage();

    expect(
      screen.getByRole("combobox", { name: /token lifetime/i }),
    ).toHaveTextContent("1 year");
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });

  it("does not show the one year fallback while the organization is loading", () => {
    mockOrganization = null;
    mockOrganizationPending = true;

    renderPage();

    expect(
      screen.getByRole("combobox", { name: /token lifetime/i }),
    ).not.toHaveTextContent("1 year");
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });
});
