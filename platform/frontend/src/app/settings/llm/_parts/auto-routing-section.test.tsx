import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auto-routing.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useAutoRoutingState,
  useUpdateAutoRoutingState,
} from "@/lib/auto-routing.query";
import { useFeature } from "@/lib/config/config.query";
import { AutoRoutingSection } from "./auto-routing-section";

const mutateAsync = vi.fn();
let mockState: { enabled: boolean } | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue({});
  mockState = { enabled: false };
  vi.mocked(useFeature).mockReturnValue(true);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
  vi.mocked(useAutoRoutingState).mockImplementation(
    () => ({ data: mockState }) as ReturnType<typeof useAutoRoutingState>,
  );
  vi.mocked(useUpdateAutoRoutingState).mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateAutoRoutingState>);
});

describe("AutoRoutingSection", () => {
  it("shows the stored switch and saves it on", async () => {
    render(<AutoRoutingSection />);
    const toggle = screen.getByRole("switch", { name: "Auto routing" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(mutateAsync).toHaveBeenCalledWith(true);
  });

  it("saves it off", async () => {
    mockState = { enabled: true };
    render(<AutoRoutingSection />);
    const toggle = screen.getByRole("switch", { name: "Auto routing" });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(mutateAsync).toHaveBeenCalledWith(false);
  });

  it("discards an unsaved change", async () => {
    render(<AutoRoutingSection />);
    const toggle = screen.getByRole("switch", { name: "Auto routing" });

    await userEvent.click(toggle);
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );

    expect(toggle).not.toBeChecked();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("renders nothing where the alpha is off", () => {
    vi.mocked(useFeature).mockReturnValue(false);
    render(<AutoRoutingSection />);

    expect(screen.queryByRole("switch")).toBeNull();
  });
});
