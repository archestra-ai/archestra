import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter, useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useOAuthClientInfo,
  useSubmitOAuthConsent,
} from "@/lib/auth/oauth.query";
import { ConsentForm } from "./consent-form";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock("@/lib/auth/oauth.query", () => ({
  useOAuthClientInfo: vi.fn(),
  useSubmitOAuthConsent: vi.fn(),
}));

const mockPush = vi.fn();
const mockMutateAsync = vi.fn();

describe("ConsentForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
    } as unknown as ReturnType<typeof useRouter>);

    vi.mocked(useSearchParams).mockReturnValue({
      get: vi.fn((key: string) => {
        if (key === "client_id") return "cursor-client";
        if (key === "client_name") return "Cursor";
        if (key === "scope") return "mcp";
        return null;
      }),
      toString: vi
        .fn()
        .mockReturnValue(
          "client_id=cursor-client&client_name=Cursor&scope=mcp",
        ),
    } as unknown as ReturnType<typeof useSearchParams>);

    vi.mocked(useOAuthClientInfo).mockReturnValue({
      data: null,
    } as ReturnType<typeof useOAuthClientInfo>);

    vi.mocked(useSubmitOAuthConsent).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useSubmitOAuthConsent>);
  });

  it("replaces the consent buttons with a return-to-app state for custom protocol redirects", async () => {
    const assignMock = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign: assignMock,
      replace: vi.fn(),
    });

    mockMutateAsync.mockResolvedValue({
      redirectTo: "cursor://oauth/callback?code=abc",
    });

    render(<ConsentForm />);

    await userEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      accept: true,
      oauth_query: "client_id=cursor-client&client_name=Cursor&scope=mcp",
      scope: "mcp",
    });
    expect(assignMock).toHaveBeenCalledWith("cursor://oauth/callback?code=abc");
    expect(screen.getByText(/Returning you to/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /switch back to it manually/i }),
    ).toHaveAttribute("href", "cursor://oauth/callback?code=abc");
    expect(
      screen.getByText(
        /You can close this tab after the authorization flow completes/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Deny" }),
    ).not.toBeInTheDocument();
  });
});
