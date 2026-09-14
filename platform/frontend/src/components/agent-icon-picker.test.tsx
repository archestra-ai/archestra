import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { emojiModuleLoaded } = vi.hoisted(() => ({
  emojiModuleLoaded: vi.fn(),
}));

vi.mock("@ferrucc-io/emoji-picker", () => {
  emojiModuleLoaded();

  const EmojiPicker = Object.assign(
    ({
      children,
      onEmojiSelect,
    }: {
      children: ReactNode;
      onEmojiSelect: (emoji: string) => void;
    }) => (
      <div>
        {children}
        <button type="button" onClick={() => onEmojiSelect("🎉")}>
          Party popper
        </button>
      </div>
    ),
    {
      Header: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Input: ({ placeholder }: { placeholder: string }) => (
        <input aria-label={placeholder} />
      ),
      Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      List: () => null,
    },
  );

  return { EmojiPicker };
});

import { AgentIconPicker } from "./agent-icon-picker";

describe("AgentIconPicker", () => {
  it("loads the emoji picker on open and keeps emoji selection accessible", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<AgentIconPicker value={null} onChange={onChange} />);

    expect(emojiModuleLoaded).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Choose icon" }));
    const emoji = await screen.findByRole("button", { name: "Party popper" });

    expect(emojiModuleLoaded).toHaveBeenCalledOnce();

    emoji.focus();
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("🎉");
    await waitFor(() => expect(emoji).not.toBeInTheDocument());
  });
});
