import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputTextarea,
} from "./prompt-input";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe("PromptInputTextarea", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls external keydown handlers without breaking enter submit", async () => {
    const onKeyDown = vi.fn();
    const onSubmit = vi.fn(
      (_message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
      },
    );

    render(
      <PromptInputProvider initialInput="Hello">
        <PromptInput onSubmit={onSubmit}>
          <PromptInputTextarea aria-label="Message" onKeyDown={onKeyDown} />
          <button type="submit">Send</button>
        </PromptInput>
      </PromptInputProvider>,
    );

    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });
});
