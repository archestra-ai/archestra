"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutateAsync = vi.fn();

let mockOrganization: Record<string, unknown> | null = null;

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: mockOrganization,
    isPending: false,
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
    mutateAsync.mockResolvedValue({
      mcpOauthAccessTokenLifetimeSeconds: 604_800,
    });
  });

  it("submits the MCP token lifetime form", async () => {
    const user = userEvent.setup();

    renderPage();

    const input = screen.getByLabelText(/token lifetime in seconds/i);
    await user.clear(input);
    await user.type(input, "604800");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        mcpOauthAccessTokenLifetimeSeconds: 604_800,
      });
    });
  });
});
