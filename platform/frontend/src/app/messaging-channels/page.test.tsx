import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentTriggersPage from "./page";

vi.mock("next/navigation");

const useTriggerStatuses = vi.fn();
vi.mock("./_components/use-trigger-statuses", () => ({
  useTriggerStatuses: () => useTriggerStatuses(),
}));

import { useRouter } from "next/navigation";

const replace = vi.fn();

describe("messaging channels index route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace,
    } as unknown as ReturnType<typeof useRouter>);
  });

  it("lands on the first channel that has a tab", () => {
    useTriggerStatuses.mockReturnValue({
      isLoading: false,
      firstActiveHref: "/messaging-channels/slack",
    });

    render(<AgentTriggersPage />);

    expect(replace).toHaveBeenCalledWith("/messaging-channels/slack");
  });

  // Redirecting with nowhere to go used to land on a channel page that then
  // announced it was turned off.
  it("stays put when every channel is turned off", () => {
    useTriggerStatuses.mockReturnValue({
      isLoading: false,
      firstActiveHref: null,
    });

    render(<AgentTriggersPage />);

    expect(replace).not.toHaveBeenCalled();
  });

  it("waits for the statuses before redirecting", () => {
    useTriggerStatuses.mockReturnValue({
      isLoading: true,
      firstActiveHref: "/messaging-channels/slack",
    });

    render(<AgentTriggersPage />);

    expect(replace).not.toHaveBeenCalled();
  });
});
