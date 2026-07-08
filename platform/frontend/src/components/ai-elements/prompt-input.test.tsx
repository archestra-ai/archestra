import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PromptInput,
  PromptInputBody,
  type PromptInputProps,
  PromptInputTextarea,
} from "./prompt-input";

beforeEach(() => {
  // jsdom has no matchMedia; the textarea's fullscreen handling (useIsMobile)
  // needs a minimal stand-in. Re-stubbed per test since stubs auto-revert.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

function renderTextarea({
  disableEnterSubmit,
  onSubmit = vi.fn(),
}: {
  disableEnterSubmit?: boolean;
  onSubmit?: PromptInputProps["onSubmit"];
}) {
  render(
    <PromptInput onSubmit={onSubmit}>
      <PromptInputBody>
        <PromptInputTextarea
          disableEnterSubmit={disableEnterSubmit}
          placeholder="Type here"
        />
      </PromptInputBody>
    </PromptInput>,
  );
  return screen.getByPlaceholderText<HTMLTextAreaElement>("Type here");
}

describe("PromptInputTextarea Enter handling", () => {
  it("inserts a newline on Shift+Enter even while Enter-submit is disabled (message in-flight)", async () => {
    const user = userEvent.setup();
    const textarea = renderTextarea({ disableEnterSubmit: true });

    await user.type(textarea, "hello");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(textarea, "world");

    expect(textarea.value).toBe("hello\nworld");
  });

  it("swallows plain Enter while Enter-submit is disabled (no newline, no submit)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const textarea = renderTextarea({ disableEnterSubmit: true, onSubmit });

    await user.type(textarea, "hello");
    await user.keyboard("{Enter}");

    expect(textarea.value).toBe("hello");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits on plain Enter when Enter-submit is enabled", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((_message, event) => event.preventDefault());
    const textarea = renderTextarea({ onSubmit });

    await user.type(textarea, "hello");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
