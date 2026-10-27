import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationRecognition } from "@/lib/chat/dictation-session";
import {
  PromptInput,
  type PromptInputProps,
  PromptInputProvider,
  PromptInputTextarea,
  usePromptInputController,
} from "./prompt-input";
import { PromptInputSpeechButton } from "./prompt-input-speech";

class Recognition implements DictationRecognition {
  static runs: Recognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();
  onstart: DictationRecognition["onstart"] = null;
  onend: DictationRecognition["onend"] = null;
  onerror: DictationRecognition["onerror"] = null;
  onresult: DictationRecognition["onresult"] = null;
  constructor() {
    Recognition.runs.push(this);
  }
  result(text: string) {
    this.onresult?.({ results: [{ isFinal: true, 0: { transcript: text } }] });
  }
}
function Composer({
  submitted,
  sendDisabled = false,
}: {
  submitted: PromptInputProps["onSubmit"];
  sendDisabled?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controller = usePromptInputController();
  return (
    <PromptInput onSubmit={submitted}>
      <PromptInputTextarea ref={textareaRef} placeholder="Message" />
      <PromptInputSpeechButton
        textareaRef={textareaRef}
        onTranscriptionChange={controller.textInput.setInput}
        sendDisabled={sendDisabled}
      />
    </PromptInput>
  );
}
function setup(sendDisabled = false) {
  const submitted = vi.fn<PromptInputProps["onSubmit"]>();
  const view = render(
    <PromptInputProvider initialInput="Typed draft">
      <Composer submitted={submitted} sendDisabled={sendDisabled} />
    </PromptInputProvider>,
  );
  return { ...view, submitted, user: userEvent.setup() };
}
beforeEach(() => {
  Recognition.runs = [];
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("SpeechRecognition", Recognition);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
describe("voice composer workflow", () => {
  it("keeps Stop editable, retains concurrent typing, and never submits", async () => {
    const { user, submitted } = setup();
    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    act(() => Recognition.runs[0].result("Spoken words"));
    expect(screen.queryByText("Spoken words")).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Message"), " edited");
    await user.click(screen.getByRole("button", { name: "Stop voice input" }));
    expect(screen.getByText("Transcribing voice input")).toBeInTheDocument();
    act(() => {
      Recognition.runs[0].result("Spoken final words");
      Recognition.runs[0].onend?.();
    });
    expect(screen.getByPlaceholderText("Message")).toHaveValue(
      "Typed draft edited Spoken final words",
    );
    expect(submitted).not.toHaveBeenCalled();
  });
  it.each([
    "button",
    "Enter",
  ])("finalizes %s submission before the normal form callback, exactly once", async (mode) => {
    const { user, submitted } = setup();
    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    act(() => Recognition.runs[0].result("interim"));
    if (mode === "button")
      await user.click(
        screen.getByRole("button", { name: "Send voice input" }),
      );
    else {
      await user.click(screen.getByPlaceholderText("Message"));
      await user.keyboard("{Enter}{Enter}");
    }
    expect(submitted).not.toHaveBeenCalled();
    act(() => {
      Recognition.runs[0].result("Final transcript");
      Recognition.runs[0].onend?.();
    });
    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    expect(submitted.mock.calls[0][0]).toMatchObject({
      text: "Typed draft Final transcript",
      files: [],
    });
  });
  it("cancels with Escape and ignores late results, preserving the original draft", async () => {
    const { user, submitted } = setup();
    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    await user.keyboard("{Escape}");
    act(() => {
      Recognition.runs[0].result("Late");
      Recognition.runs[0].onend?.();
    });
    expect(screen.getByPlaceholderText("Message")).toHaveValue("Typed draft");
    expect(submitted).not.toHaveBeenCalled();
  });
  it("respects blocked sends for both Enter and the recording Send control", async () => {
    const { user, submitted } = setup(true);
    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    expect(
      screen.getByRole("button", { name: "Send voice input" }),
    ).toBeDisabled();
    await user.click(screen.getByPlaceholderText("Message"));
    await user.keyboard("{Enter}");
    expect(Recognition.runs[0].stop).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });
  it("preserves staged attachments through Stop and the following Send", async () => {
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "data:text/plain;base64,bm90ZXM=");
        static revokeObjectURL = vi.fn();
      },
    );
    const { user, submitted, container } = setup();
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("Composer file input is missing");
    await user.upload(
      input,
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );
    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    act(() => Recognition.runs[0].result("First recording"));
    await user.click(screen.getByRole("button", { name: "Stop voice input" }));
    act(() => Recognition.runs[0].onend?.());
    expect(submitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    act(() => Recognition.runs[1].result("Second recording"));
    await user.click(screen.getByRole("button", { name: "Send voice input" }));
    act(() => Recognition.runs[1].onend?.());
    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    expect(submitted.mock.calls[0][0]).toMatchObject({
      text: "Typed draft First recording Second recording",
      files: [
        {
          filename: "notes.txt",
          mediaType: "text/plain",
          url: "data:text/plain;base64,bm90ZXM=",
        },
      ],
    });
  });
  it("aborts on navigation/unmount and releases a late waveform stream", async () => {
    let resolve: (stream: MediaStream) => void = () => {};
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((done) => {
              resolve = done;
            }),
        ),
      },
    });
    const { user, unmount } = setup();
    await user.click(screen.getByRole("button", { name: "Start voice input" }));
    unmount();
    await act(async () => {
      resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(Recognition.runs[0].abort).toHaveBeenCalledOnce();
  });
});
