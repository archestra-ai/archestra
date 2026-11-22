import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useK8sCapabilities } from "@/lib/environment.query";

vi.mock("@archestra/shared/api-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared/api-sdk")>()),
  getK8sCapabilities: vi.fn(),
}));
vi.mock("@/lib/auth/auth.query");
vi.mock("sonner");

const sdk = vi.mocked(archestraApiSdk);
const capabilities = {
  networkPolicy: { supportsFqdn: true, enforcementStatus: "verified-enforced" },
};
/** What the API answers someone without `environment:update`. */
const refused = {
  data: undefined,
  error: {
    error: {
      message:
        "You don't have permission to get K8s capabilities. Missing permission: environment:update",
      type: "api_authorization_error",
    },
  },
};

function setup(enabled?: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useK8sCapabilities(enabled), { wrapper });
}

/** `environment:update` as the hook asks for it, and nothing else. */
function grant(allowed: boolean) {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data:
          allowed &&
          JSON.stringify(permissions) ===
            JSON.stringify({ environment: ["update"] }),
      }) as ReturnType<typeof useHasPermissions>,
  );
}

describe("useK8sCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends nothing for someone without environment:update, whatever the caller passes, and shows no refusal", async () => {
    grant(false);
    sdk.getK8sCapabilities.mockResolvedValue(refused as never);

    const { result } = setup(true);

    // Nothing is pending and nothing arrives: the read was never made.
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(result.current.data).toBeUndefined();
    expect(sdk.getK8sCapabilities).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reads the cluster for someone with environment:update", async () => {
    grant(true);
    sdk.getK8sCapabilities.mockResolvedValue({
      data: capabilities,
      error: undefined,
    } as never);

    const { result } = setup();

    await waitFor(() => expect(result.current.data).toEqual(capabilities));
    expect(sdk.getK8sCapabilities).toHaveBeenCalledTimes(1);
  });

  it("still waits for a caller that turns it off", async () => {
    grant(true);

    const { result } = setup(false);

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(sdk.getK8sCapabilities).not.toHaveBeenCalled();
  });
});
