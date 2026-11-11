import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KeyAutoRouters } from "@/components/credential-billing/key-auto-routers";
import { useAutoRouters } from "@/lib/auto-routing.query";

vi.mock("@/lib/auto-routing.query");
vi.mock("@/lib/config/config.query", () => ({ useFeature: () => true }));

const tier = (modelId: string) => ({
  id: modelId,
  provider: "openai",
  modelId,
  apiKey: { id: "key", name: "Shared" },
});
const routers = [
  {
    id: "r1",
    name: "auto:support",
    virtualApiKeyIds: ["vk-1"],
    tiers: {
      fast: tier("gpt-5-mini"),
      normal: tier("gpt-5.4"),
      smart: null,
    },
  },
  {
    id: "r2",
    name: "auto",
    virtualApiKeyIds: [],
    tiers: { fast: null, normal: null, smart: null },
  },
];
const mockRouters = (data: unknown) =>
  vi.mocked(useAutoRouters).mockReturnValue({
    data,
  } as unknown as ReturnType<typeof useAutoRouters>);

describe("KeyAutoRouters", () => {
  it("shows the key's routers and where each tier goes once opened", async () => {
    mockRouters(routers);
    render(<KeyAutoRouters virtualApiKeyId="vk-1" />);

    await userEvent.click(
      screen.getByRole("button", { name: "1 auto router on this key" }),
    );

    expect(screen.getByText("auto:support")).toBeInTheDocument();
    expect(screen.getByText("gpt-5-mini")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.4")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.queryByText("auto")).not.toBeInTheDocument();
  });

  it("says when the key has none", () => {
    mockRouters(routers);
    render(<KeyAutoRouters virtualApiKeyId="vk-2" />);

    expect(screen.getByText("No auto routers on this key")).toBeInTheDocument();
  });

  it("shows the routers added to an OAuth client", () => {
    mockRouters(routers);
    render(<KeyAutoRouters routerIds={["r2"]} noun="client" />);

    expect(
      screen.getByRole("button", { name: "1 auto router on this client" }),
    ).toBeInTheDocument();
  });

  it("renders nothing while the organization has no router", () => {
    mockRouters([]);
    const { container } = render(<KeyAutoRouters virtualApiKeyId="vk-1" />);

    expect(container).toBeEmptyDOMElement();
  });
});
