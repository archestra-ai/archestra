import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ReplayChatEditPane,
  SubmissionReadinessNotice,
} from "./app-session-player";

// The chat pane's scroll container (use-stick-to-bottom) needs ResizeObserver,
// which jsdom lacks. Stub the ai-elements to plain pass-throughs — the fix
// under test is the header controls and the prompt editor, not the scroller.
vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/ai-elements/message", () => ({
  Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/ai-elements/loader", () => ({ Loader: () => null }));
// Audio playback is a WebCodecs/opus-decoder boundary the player pulls in, and
// it's unrelated to the chat edit pane — stub it so the test doesn't drag in
// (and try to resolve) the audio-decode dependency graph.
vi.mock("@/lib/app-session-recording/app-recording-audio", () => ({
  AudioPlaybackController: class {},
  buildPlaybackAudio: vi.fn(),
  preparePlaybackAudio: vi.fn(),
  recordingHasAudio: vi.fn(() => false),
}));

type Props = ComponentProps<typeof ReplayChatEditPane>;

const TRANSCRIPT: Props["transcript"] = [
  {
    id: "u1",
    role: "user",
    atMs: 0,
    parts: [{ type: "text", text: "make it roast AI slop" }],
  },
];

function makeEditor(
  over: Partial<Props["promptEditor"]> = {},
): Props["promptEditor"] {
  return {
    draft: null,
    generating: false,
    saving: false,
    start: vi.fn(),
    change: vi.fn(),
    save: vi.fn(),
    cancel: vi.fn(),
    regenerate: vi.fn(),
    ...over,
  };
}

function renderEditPane(over: Partial<Props> = {}) {
  const props: Props = {
    transcript: TRANSCRIPT,
    enhancement: null,
    chat: undefined,
    saving: false,
    promptEditor: makeEditor(),
    responseEditor: makeEditor(),
    onToggleEnhancement: vi.fn(),
    onRemove: vi.fn(),
    onRestore: vi.fn(),
    onDone: vi.fn(),
    ...over,
  };
  render(<ReplayChatEditPane {...props} />);
  return props;
}

describe("ReplayChatEditPane build prompt", () => {
  // The gallery submission is gated on a build prompt, and the AI draft runs
  // over the chat's LLM — which can be unavailable even for a working app. The
  // hand-written path is the escape hatch that keeps sharing possible.
  it("offers a manual 'Write build prompt' path alongside the AI draft when no prompt exists", async () => {
    const user = userEvent.setup();
    const promptEditor = makeEditor();
    renderEditPane({ promptEditor });

    expect(
      screen.getByRole("button", { name: /draft ai prompt/i }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /write build prompt/i }),
    );
    expect(promptEditor.start).toHaveBeenCalledTimes(1);
  });

  it("opens a from-scratch prompt editor even with no AI-drafted prompt, and won't save it empty", () => {
    renderEditPane({ promptEditor: makeEditor({ draft: "" }) });

    // The editable prompt field is reachable with no enhancement present.
    expect(
      screen.getByPlaceholderText(/single prompt that would have produced/i),
    ).toBeInTheDocument();
    // An empty hand-written prompt can't be saved (it would fail the gate).
    const regenerate = screen.getByRole("button", { name: /regenerate/i });
    const editorFooter = regenerate.closest("div") as HTMLElement;
    expect(
      within(editorFooter).getByRole("button", { name: "Save" }),
    ).toBeDisabled();
  });

  it("saves a hand-written build prompt without any AI generation", async () => {
    const user = userEvent.setup();
    const promptEditor = makeEditor({ draft: "build me an AI slop detector" });
    renderEditPane({ promptEditor });

    const regenerate = screen.getByRole("button", { name: /regenerate/i });
    const editorFooter = regenerate.closest("div") as HTMLElement;
    const save = within(editorFooter).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();

    await user.click(save);
    expect(promptEditor.save).toHaveBeenCalledTimes(1);
  });
});

describe("SubmissionReadinessNotice", () => {
  // The builder must learn on open — not at the submit button — that the
  // gallery card is missing fields, with a one-click way to fix each.
  it("names both missing fields and wires each fix action", async () => {
    const user = userEvent.setup();
    const onAddDescription = vi.fn();
    const onWriteBuildPrompt = vi.fn();
    const onDismiss = vi.fn();
    render(
      <SubmissionReadinessNotice
        needsDescription
        needsPrompt
        onAddDescription={onAddDescription}
        onWriteBuildPrompt={onWriteBuildPrompt}
        onDismiss={onDismiss}
      />,
    );

    expect(
      screen.getByText(/still needs a description and a build prompt/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /add description/i }));
    expect(onAddDescription).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: /write build prompt/i }),
    );
    expect(onWriteBuildPrompt).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("only offers the build-prompt fix when the description is already set", () => {
    render(
      <SubmissionReadinessNotice
        needsDescription={false}
        needsPrompt
        onAddDescription={vi.fn()}
        onWriteBuildPrompt={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /add description/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /write build prompt/i }),
    ).toBeInTheDocument();
  });
});
