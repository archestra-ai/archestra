import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
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
  useCreateModelPool: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
vi.mock("@/components/virtual-key-connection-base-url", () => ({
  useConnectionBaseUrl: () => "http://localhost:9000/v1",
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { type ModelPool, useModelPools } from "@/lib/model-pools.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { PoolDialog } from "./pool-dialog";

const NOW = Date.now();

function pool(benchedUntil: string | null): ModelPool {
  return {
    id: "pool",
    organizationId: "org",
    name: "glm-5",
    streamTimeoutSeconds: null,
    timeoutSeconds: null,
    cooldownSeconds: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    virtualApiKeyIds: [],
    members: ["glm-5", "glm-5-air"].map((modelId) => ({
      id: modelId,
      poolId: "pool",
      providerApiKeyId: "key",
      providerApiKeyName: "Z.ai",
      provider: "zhipuai",
      modelId,
      priority: 1,
      weight: 1,
      enabled: true,
      createdAt: new Date(NOW).toISOString(),
      benchedUntil: modelId === "glm-5" ? benchedUntil : null,
      benchReason:
        modelId === "glm-5" && benchedUntil ? "rate_limited (429)" : null,
    })),
  } as ModelPool;
}

describe("PoolDialog", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useAppearanceSettings>);
  });

  it("keeps edits in progress when the list refetches with new status", async () => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    const { rerender } = render(
      <PoolDialog pool={saved} onOpenChange={() => {}} />,
    );

    const weight = screen.getAllByRole("spinbutton", { name: /Weight/ })[0];
    await user.clear(weight);
    await user.type(weight, "5");

    // The 5 s refetch brings a new pool object: the member is now benched.
    const refetched = pool(new Date(NOW + 20_000).toISOString());
    vi.mocked(useModelPools).mockReturnValue({
      data: [refetched],
    } as unknown as ReturnType<typeof useModelPools>);
    rerender(<PoolDialog pool={refetched} onOpenChange={() => {}} />);

    expect(
      screen.getAllByRole("spinbutton", { name: /Weight/ })[0],
    ).toHaveValue(5);
    expect(screen.getByText(/Cooling down · \d+ s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("keeps Save off while a weight is out of range", async () => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    render(<PoolDialog pool={saved} onOpenChange={() => {}} />);
    const input = screen.getAllByRole("spinbutton", { name: /Weight/ })[0];
    await user.clear(input);
    await user.type(input, "1001");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("takes a pool's timeouts in whole seconds, within the API's limits", async () => {
    const user = userEvent.setup();
    const saved = pool(null);
    vi.mocked(useModelPools).mockReturnValue({
      data: [saved],
    } as unknown as ReturnType<typeof useModelPools>);
    render(<PoolDialog pool={saved} onOpenChange={() => {}} />);
    const input = screen.getByLabelText("Stream timeout");
    await user.type(input, "1.5");
    expect(input).toHaveValue("15");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await user.type(input, "000");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("opens a big pool with the orders after the first folded", async () => {
    const user = userEvent.setup();
    const saved = pool(null);
    const big = {
      ...saved,
      members: ["a", "b", "c", "d", "e"].map((modelId, index) => ({
        ...saved.members[0],
        id: modelId,
        modelId,
        priority: index < 2 ? 1 : 2,
        benchedUntil:
          modelId === "e" ? new Date(NOW + 20_000).toISOString() : null,
      })),
    } as ModelPool;
    vi.mocked(useModelPools).mockReturnValue({
      data: [big],
    } as unknown as ReturnType<typeof useModelPools>);
    render(<PoolDialog pool={big} onOpenChange={() => {}} />);
    const fold = screen.getByRole("button", { name: "Expand order 2" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    // Its rows are hidden, so the header says a member is cooling down.
    expect(screen.getByText("1 cooling down")).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton", { name: /Weight/ })).toHaveLength(
      2,
    );
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getAllByRole("spinbutton", { name: /Weight/ })).toHaveLength(
      5,
    );

    // An order holding a value that keeps Save off won't fold away.
    const lastWeight = screen.getAllByRole("spinbutton", { name: /Weight/ })[4];
    await user.clear(lastWeight);
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getAllByRole("spinbutton", { name: /Weight/ })).toHaveLength(
      3,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // Fixed, it stays open until folded again.
    await user.type(lastWeight, "2");
    expect(screen.getAllByRole("spinbutton", { name: /Weight/ })).toHaveLength(
      3,
    );
  });
});
