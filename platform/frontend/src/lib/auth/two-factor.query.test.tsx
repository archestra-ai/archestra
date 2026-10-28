import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useEnableTwoFactorMutation } from "./two-factor.query";

vi.mock("@/lib/clients/auth/auth-client");
vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");

beforeEach(() => {
  vi.clearAllMocks();
});

async function enroll() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result, unmount } = renderHook(() => useEnableTwoFactorMutation(), {
    wrapper,
  });
  let secrets: Awaited<ReturnType<typeof result.current.mutateAsync>> = null;
  await act(async () => {
    secrets = await result.current.mutateAsync({
      password: "test-password",
      issuer: "Example Workspace",
    });
  });
  unmount();
  client.clear();
  return secrets;
}

it("enrolls an authenticator and returns its QR secret and recovery codes", async () => {
  const data = {
    method: "totp" as const,
    totpURI: "otpauth://totp/Example:demo?secret=TEST",
    backupCodes: ["recovery-code"],
  };
  vi.mocked(authClient.twoFactor.enable).mockResolvedValue({
    data,
    error: null,
  });
  expect(await enroll()).toEqual(data);
  expect(authClient.twoFactor.enable).toHaveBeenCalledWith({
    password: "test-password",
    issuer: "Example Workspace",
    method: "totp",
  });
});

it("does not advance authenticator setup for an OTP-only response", async () => {
  vi.mocked(authClient.twoFactor.enable).mockResolvedValue({
    data: { method: "otp" },
    error: null,
  });
  expect(await enroll()).toBeNull();
  expect(toast.error).toHaveBeenCalledWith(
    "Failed to set up the authenticator app",
  );
});
