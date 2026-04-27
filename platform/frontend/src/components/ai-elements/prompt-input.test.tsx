import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptInputProvider, PromptInputTextarea } from "./prompt-input";

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
  it("assigns the forwarded textarea ref to the rendered textarea", () => {
    const textareaRef = { current: null as HTMLTextAreaElement | null };

    render(
      <PromptInputProvider>
        <PromptInputTextarea
          data-testid="prompt-textarea"
          placeholder="Type here"
          ref={textareaRef}
        />
      </PromptInputProvider>,
    );

    const textarea = screen.getByTestId("prompt-textarea");

    expect(textareaRef.current).toBe(textarea);
  });
});
