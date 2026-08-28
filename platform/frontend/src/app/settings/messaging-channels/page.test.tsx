import { render } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MessagingChannelSettingsPage from "./page";

vi.mock("next/navigation");

const useTriggerStatuses = vi.fn();
vi.mock("./_components/use-trigger-statuses", () => ({
  useTriggerStatuses: () => useTriggerStatuses(),
}));

const replace = vi.fn();

describe("messaging channel settings index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
  });

  it("lands on the first available provider inside Settings", () => {
    useTriggerStatuses.mockReturnValue({
      isLoading: false,
      firstProviderHref: "/settings/messaging-channels/slack",
    });

    render(<MessagingChannelSettingsPage />);

    expect(replace).toHaveBeenCalledWith("/settings/messaging-channels/slack");
  });

  it("waits until provider availability has loaded", () => {
    useTriggerStatuses.mockReturnValue({
      isLoading: true,
      firstProviderHref: "/settings/messaging-channels/slack",
    });

    render(<MessagingChannelSettingsPage />);

    expect(replace).not.toHaveBeenCalled();
  });

  it("stays on the empty state when every provider is unavailable", () => {
    useTriggerStatuses.mockReturnValue({
      isLoading: false,
      firstProviderHref: null,
    });

    render(<MessagingChannelSettingsPage />);

    expect(replace).not.toHaveBeenCalled();
  });
});
