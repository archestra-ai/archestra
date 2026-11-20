import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useStopImpersonating } from "./impersonation.query";

vi.mock("@/lib/clients/auth/auth-client");
vi.mock("sonner");

const originalLocation = window.location;
const assign = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

test("returning to the admin session sends a JSON body, which a page whose address has a query string needs", async () => {
  vi.mocked(authClient.$fetch).mockResolvedValue({
    data: {},
    error: null,
  } as never);
  const { result } = renderHook(() => useStopImpersonating(), { wrapper });

  await result.current.mutateAsync();

  // A body-less POST from such a page is refused (see useStopImpersonating).
  expect(authClient.$fetch).toHaveBeenCalledWith("/admin/stop-impersonating", {
    method: "POST",
    body: {},
  });
  expect(assign).toHaveBeenCalledWith("/");
});
