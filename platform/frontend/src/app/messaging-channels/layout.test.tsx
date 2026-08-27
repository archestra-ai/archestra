import { render } from "@testing-library/react";
import { usePathname, useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LegacyMessagingChannelsLayout from "./layout";

vi.mock("next/navigation");

const replace = vi.fn();

describe("legacy messaging channel routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ replace } as never);
  });

  it("forwards provider bookmarks to Settings", () => {
    vi.mocked(usePathname).mockReturnValue("/messaging-channels/slack");

    render(
      <LegacyMessagingChannelsLayout>
        <div>legacy content</div>
      </LegacyMessagingChannelsLayout>,
    );

    expect(replace).toHaveBeenCalledWith("/settings/messaging-channels/slack");
  });

  it("sends the old A2A picker to Agents", () => {
    vi.mocked(usePathname).mockReturnValue("/messaging-channels/a2a");

    render(
      <LegacyMessagingChannelsLayout>
        <div>legacy content</div>
      </LegacyMessagingChannelsLayout>,
    );

    expect(replace).toHaveBeenCalledWith("/agents");
  });
});
