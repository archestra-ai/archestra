import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("next/image", () => ({
  default: ({
    alt,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string }) => (
    <img alt={alt} {...props} />
  ),
}));
vi.mock("@/lib/model-pools.query", () => ({
  useModelPools: vi.fn(),
  useUpdateModelPool: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({
    data: [{ id: "key", name: "Z.ai", provider: "zhipuai", userId: null }],
  }),
}));
vi.mock("@/lib/llm-models.query", () => ({
  useModelsWithApiKeys: () => ({ data: [] }),
}));
vi.mock("@/lib/virtual-api-keys.query", () => ({
  useAllVirtualApiKeys: () => ({ data: { data: [] } }),
}));
vi.mock("@/components/virtual-key-connection-base-url", () => ({
  useConnectionBaseUrl: () => "http://localhost:9000/v1",
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { type ModelPool, useModelPools } from "@/lib/model-pools.query";
import { EditPoolDialog } from "./edit-pool-dialog";

const NOW = Date.now();

function pool(benchedUntil: string | null): ModelPool {
  return {
    id: "pool",
    organizationId: "org",
    name: "glm-5",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    virtualApiKeyIds: [],
    members: [
      {
        id: "member",
        poolId: "pool",
        providerApiKeyId: "key",
        providerApiKeyName: "Z.ai",
        provider: "zhipuai",
        modelId: "glm-5",
        priority: 1,
        weight: 1,
        enabled: true,
        createdAt: new Date(NOW).toISOString(),
        benchedUntil,
        benchReason: benchedUntil ? "rate_limited (429)" : null,
      },
    ],
  } as ModelPool;
}

describe("EditPoolDialog", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
  });

  it("keeps edits in progress when the list refetches with new status", async () => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    const { rerender } = render(
      <EditPoolDialog pool={saved} onOpenChange={() => {}} />,
    );

    await user.click(screen.getAllByRole("button", { name: "Members" })[0]);
    const weight = screen.getByRole("spinbutton", { name: /Weight/ });
    await user.clear(weight);
    await user.type(weight, "5");

    // The 5 s refetch brings a new pool object: the member is now benched.
    const refetched = pool(new Date(NOW + 20_000).toISOString());
    vi.mocked(useModelPools).mockReturnValue({
      data: [refetched],
    } as unknown as ReturnType<typeof useModelPools>);
    rerender(<EditPoolDialog pool={refetched} onOpenChange={() => {}} />);

    expect(screen.getByRole("spinbutton", { name: /Weight/ })).toHaveValue(5);
    expect(screen.getByText(/Benched \d+ s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  it.each([
    ["Weight", ""],
    ["Weight", "0"],
    ["Weight", "1001"],
  ])("keeps Save off while %s is %j", async (field, value) => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    render(<EditPoolDialog pool={saved} onOpenChange={() => {}} />);
    await user.click(screen.getAllByRole("button", { name: "Members" })[0]);
    const input = screen.getByRole("spinbutton", { name: new RegExp(field) });
    await user.clear(input);
    if (value) await user.type(input, value);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("asks before Cancel discards edits", async () => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    const onOpenChange = vi.fn();
    render(<EditPoolDialog pool={saved} onOpenChange={onOpenChange} />);
    await user.click(screen.getAllByRole("button", { name: "Members" })[0]);
    const weight = screen.getByRole("spinbutton", { name: /Weight/ });
    await user.clear(weight);
    await user.type(weight, "5");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByText("Discard unsaved changes?"),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
