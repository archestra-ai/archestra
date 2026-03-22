import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEditor = vi.fn();

vi.mock("@/components/editor", () => ({
  Editor: (props: unknown) => {
    mockEditor(props);
    return <div data-testid="mock-editor" />;
  },
}));

import { SystemPromptEditor } from "./system-prompt-editor";

describe("SystemPromptEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables Monaco word-based autocomplete while keeping the custom editor configuration", () => {
    render(<SystemPromptEditor value="" onChange={() => {}} />);

    expect(mockEditor).toHaveBeenCalledTimes(1);
    const editorProps = mockEditor.mock.calls[0]?.[0] as {
      options?: Record<string, unknown>;
    };

    expect(editorProps.options).toMatchObject({
      quickSuggestions: false,
      wordBasedSuggestions: "off",
      editContext: false,
      wordWrap: "on",
    });
  });
});
