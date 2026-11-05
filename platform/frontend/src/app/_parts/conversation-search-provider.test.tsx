import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import { ConversationSearchProvider } from "./conversation-search-provider";

vi.mock("next/navigation");
vi.mock("@/lib/config/config.query");
// The app never becomes interactive here, so only a shortcut can mount it.
vi.mock("@/lib/app-interactive", () => ({
  appInteractive: { whenIdle: () => new Promise(() => undefined) },
}));
// The palette's own behaviour is covered by its tests; this is about when it mounts.
vi.mock("./conversation-search-palette", () => ({
  ConversationSearchPalette: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Search conversations</div> : null,
}));

describe("ConversationSearchProvider", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useFeature).mockReturnValue(false);
  });

  it("opens the palette from the shortcut before it has been loaded", async () => {
    const { container } = render(<ConversationSearchProvider />);
    // Nothing mounted until it is needed.
    expect(container).toBeEmptyDOMElement();

    act(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });

    expect(await screen.findByRole("dialog", { name: "" })).toHaveTextContent(
      "Search conversations",
    );
  });
});
