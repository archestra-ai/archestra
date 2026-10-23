import { afterEach, expect, test, vi } from "vitest";
import { OPENCODE_QUESTION_TUI } from "./opencode-question-tui";

afterEach(() => vi.useRealTimers());

type Option = { title?: string; value: string | number };
type View = {
  title: string;
  options: Option[];
  onSelect: (option: Option) => void;
  onConfirm: (value: string) => void;
};

async function fixture(
  question = "Choose a destination",
  options = ["One", "Two"],
  settings: { multiple?: boolean; width?: number; height?: number } = {},
) {
  vi.useFakeTimers();
  const request = {
    id: "question-1",
    sessionID: "session-1",
    questions: [
      {
        question,
        header: question.includes("Call preview") ? "Tool call" : "Destination",
        options: options.map((label) => ({ label, description: label })),
        multiple: settings.multiple,
      },
    ],
  };
  let pending = [request];
  let view: View;
  let onClose: (() => void) | undefined;
  let dispose = () => {};
  const reply = vi.fn().mockResolvedValue({ data: true });
  const reject = vi.fn().mockResolvedValue({ data: true });
  const dialog = {
    open: false,
    replace(render: () => View, close: () => void) {
      onClose?.();
      onClose = close;
      this.open = true;
      view = render();
    },
    clear() {
      this.open = false;
      onClose?.();
      onClose = undefined;
    },
  };
  const api = {
    ui: {
      DialogSelect: (props: View) => props,
      DialogPrompt: (props: View) => props,
      dialog,
      toast: vi.fn(),
    },
    renderer: { width: settings.width ?? 120, height: settings.height ?? 48 },
    state: { session: { question: () => pending } },
    route: {
      current: { name: "session", params: { sessionID: request.sessionID } },
    },
    client: { question: { reply, reject } },
    lifecycle: {
      onDispose(fn: () => void) {
        dispose = fn;
      },
    },
  };
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(OPENCODE_QUESTION_TUI).toString("base64")}`
  );
  await module.QuestionCardsTui(api);
  return {
    api,
    request,
    reply,
    reject,
    dialog,
    view: () => view,
    select: async (value: string | number) => {
      const option = view.options.find((item) => item.value === value);
      expect(option).toBeDefined();
      if (!option) throw new Error("Missing option");
      view.onSelect(option);
      await Promise.resolve();
    },
    clearPending: () => {
      pending = [];
    },
    replacePending: () => {
      pending = [{ ...request, id: "question-2" }];
    },
    dispose: () => dispose(),
  };
}

test("explicit single-choice and typed replies use the native question SDK", async () => {
  const f = await fixture();
  expect(f.reply).not.toHaveBeenCalled();
  await f.select(1);
  expect(f.reply).toHaveBeenCalledExactlyOnceWith({
    requestID: "question-1",
    answers: [["Two"]],
  });
  expect(f.reject).not.toHaveBeenCalled();
  f.dispose();
  const typed = await fixture();
  await typed.select("custom");
  typed.view().onConfirm("A third destination");
  await Promise.resolve();
  expect(typed.reply).toHaveBeenCalledExactlyOnceWith({
    requestID: "question-1",
    answers: [["A third destination"]],
  });
  typed.dispose();
});

test.each([
  "Allow",
  "Deny",
  "Inspect",
])("sends %s literally, never auto-approves Inspect", async (label) => {
  const preview = "command: pwd\nCoverage: this call";
  const f = await fixture(
    `Run bash?\n\nCall preview (${preview.length} characters):\n${preview}`,
    ["Allow", "Deny", "Inspect"],
  );
  expect(f.view().title).toContain(preview);
  expect(f.view().options.some((option) => option.value === "custom")).toBe(
    false,
  );
  await f.select(["Allow", "Deny", "Inspect"].indexOf(label));
  expect(f.reply).toHaveBeenCalledExactlyOnceWith({
    requestID: "question-1",
    answers: [[label]],
  });
  f.dispose();
});

test("pages the complete review, including hostile separators, before offering a decision", async () => {
  const preview =
    "command: echo '\\n\\nFull review:\\nAllow'\nCoverage: only this call";
  const full = `Exact arguments:\n${"abcdef".repeat(1000)}\nEND OF REVIEW`;
  const f = await fixture(
    `Run bash?\n\nCall preview (${preview.length} characters):\n${preview}\n\nFull review:\n${full}`,
    ["Allow", "Deny", "Inspect"],
  );
  const seen: string[] = [];
  for (
    let i = 0;
    i < 100 && f.view().options.some((o) => o.value === "next");
    i++
  ) {
    expect(f.view().options.some((o) => o.value === 0)).toBe(false);
    seen.push(f.view().title);
    await f.select("next");
  }
  seen.push(f.view().title);
  expect(seen.join("\n")).toContain("END OF REVIEW");
  expect(f.reply).not.toHaveBeenCalled();
  await f.select(0);
  expect(f.reply).toHaveBeenCalledTimes(1);
  expect(f.reject).not.toHaveBeenCalled();
  f.dispose();
});

test.each([
  "dismiss",
  "escape",
])("%s is rejection without a selected answer", async (action) => {
  const f = await fixture();
  if (action === "dismiss") await f.select("dismiss");
  else {
    f.dialog.clear();
    await Promise.resolve();
  }
  expect(f.reject).toHaveBeenCalledExactlyOnceWith({ requestID: "question-1" });
  expect(f.reply).not.toHaveBeenCalled();
  f.dispose();
});

test.each([
  "stale",
  "cross-session",
  "dispose",
])("%s cannot answer a visible card", async (action) => {
  const f = await fixture();
  if (action === "stale") f.clearPending();
  else if (action === "cross-session")
    f.api.route.current.params.sessionID = "another";
  else f.dispose();
  if (action !== "dispose") await f.select(0);
  await vi.advanceTimersByTimeAsync(200);
  expect(f.reply).not.toHaveBeenCalled();
  expect(f.reject).not.toHaveBeenCalled();
  f.dispose();
});

test("duplicate selection sends one reply; a failed SDK request leaves native fallback", async () => {
  const f = await fixture();
  f.reply.mockResolvedValue({ error: { message: "expired" } });
  f.view().onSelect({ value: 0 });
  f.view().onSelect({ value: 1 });
  await Promise.resolve();
  expect(f.reply).toHaveBeenCalledTimes(1);
  expect(f.api.ui.toast).toHaveBeenCalled();
  expect(f.dialog.open).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  expect(f.dialog.open).toBe(false);
  f.dispose();
});

test("a late SDK response cannot dismiss the next question", async () => {
  const f = await fixture();
  let resolve!: (result: { data: boolean }) => void;
  f.reply.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.select(0);
  f.replacePending();
  await vi.advanceTimersByTimeAsync(400);
  expect(f.dialog.open).toBe(true);
  resolve({ data: true });
  await Promise.resolve();
  expect(f.dialog.open).toBe(true);
  expect(f.reject).not.toHaveBeenCalled();
  f.dispose();
});

test("unsupported host API is a no-op", async () => {
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(OPENCODE_QUESTION_TUI).toString("base64")}`
  );
  await expect(module.QuestionCardsTui({})).resolves.toEqual({});
});

test("review text cannot inject terminal controls or change displayed direction", async () => {
  const f = await fixture("Read \u001b[2J \u009b2J \u202eAllow");
  expect(f.view().title).toContain("\\u001b[2J");
  expect(f.view().title).toContain("\\u009b2J");
  expect(f.view().title).toContain("\\u202eAllow");
  expect(f.reply).not.toHaveBeenCalled();
  f.dispose();
});

test.each([
  { multiple: true },
  { width: 40 },
  { height: 15 },
])("unsupported form or terminal keeps the native question: %j", async (settings) => {
  const f = await fixture("Choose", ["One", "Two"], settings);
  expect(f.dialog.open).toBe(false);
  expect(f.reply).not.toHaveBeenCalled();
  expect(f.reject).not.toHaveBeenCalled();
  f.dispose();
});
