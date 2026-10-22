/**
 * Part of the managed connection plugin, loaded only by the client's TUI host.
 * Uses the released V1 host dialogs and question SDK; no private renderer API,
 * JSX runtime, model callback, or network credential is needed here.
 */
export const OPENCODE_QUESTION_TUI = String.raw`
export async function ArchestraQuestionsTui(api) {
  if (!api?.ui?.DialogSelect || !api.ui.DialogPrompt || !api.ui.dialog ||
      !api.state?.session?.question || !api.client?.question?.reply ||
      !api.client.question.reject || !api.lifecycle?.onDispose) return {};
  let active;
  let disposed = false;
  const seen = new Set();
  const clean = value => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  const currentSession = () => api.route?.current?.name === "session" ? api.route.current.params?.sessionID : undefined;
  const pending = request => currentSession() === request.sessionID &&
    api.state.session.question(request.sessionID).some(item => item.id === request.id);
  const pages = text => {
    const width = Math.max(12, Math.min(54, Math.floor((api.renderer?.width ?? 100) / 2) - 8));
    const height = Math.max(2, Math.min(10, Math.floor((api.renderer?.height ?? 40) / 2) - 8));
    const lines = clean(text).replace(/\t/g, "  ").split("\n").flatMap(line => {
      if (!line.length) return [""];
      const rows = [];
      let row = "", columns = 0;
      for (const char of line) {
        // Conservatively reserve two cells for non-ASCII, including wide
        // glyphs. Extra wrapping is preferable to clipping review content.
        const cells = char.codePointAt(0) > 127 ? 2 : 1;
        if (columns + cells > width) { rows.push(row); row = ""; columns = 0; }
        row += char; columns += cells;
      }
      if (row) rows.push(row);
      return rows;
    });
    const result = [];
    for (let i = 0; i < lines.length; i += height) result.push(lines.slice(i, i + height).join("\n"));
    return result.length ? result : [""];
  };
  const close = state => {
    state.transition = true;
    // A late SDK response must not close (and thereby dismiss) a newer card.
    if (active !== state) return;
    active = undefined;
    api.ui.dialog.clear();
  };
  const submit = async (state, answers) => {
    if (state.busy || state.done || !pending(state.request)) return;
    state.busy = true;
    try {
      const response = answers === null
        ? await api.client.question.reject({ requestID: state.request.id })
        : await api.client.question.reply({ requestID: state.request.id, answers: [answers] });
      if (response?.error) throw new Error("Question is no longer available");
      state.done = true;
      close(state);
    } catch {
      state.busy = false;
      close(state);
      api.ui.toast?.({ title: "Answer not sent", message: "Use the native question below to retry.", variant: "error" });
    }
  };
  const replace = (state, render) => {
    state.transition = true;
    api.ui.dialog.replace(render, () => {
      // Escape is dismissal, never a selected Deny/Allow. Replacing a dialog
      // while paging is not dismissal either.
      if (!state.transition && !state.done && active === state) void submit(state, null);
    });
    state.transition = false;
  };
  const show = state => {
    const q = state.request.questions[0];
    const page = state.pages[state.page];
    const last = state.page === state.pages.length - 1;
    const options = [];
    if (!last) options.push({ title: "Continue reading", value: "next", description: "Show the next page; no answer is sent." });
    if (state.page > 0) options.push({ title: "Previous page", value: "previous" });
    if (last) {
      q.options.forEach((option, index) => options.push({
        title: clean(option.label), value: index, description: clean(option.description ?? ""),
      }));
      if (!state.review && q.custom !== false) options.push({ title: "Type an answer", value: "custom" });
    }
    options.push({ title: "Dismiss", value: "dismiss", description: "Close without approving or denying." });
    replace(state, () => api.ui.DialogSelect({
      title: (state.review ? "Tool call review" : clean(q.header || "Question")) +
        (state.pages.length > 1 ? " · " + (state.page + 1) + "/" + state.pages.length : "") + "\n\n" + page,
      placeholder: "Choose an option", flat: true, options,
      onSelect: option => {
        if (state.busy || state.done || !pending(state.request)) return;
        if (option.value === "next") { state.page++; show(state); }
        else if (option.value === "previous") { state.page--; show(state); }
        else if (option.value === "dismiss") void submit(state, null);
        else if (option.value === "custom") replace(state, () => api.ui.DialogPrompt({
          title: "Your answer",
          onConfirm: value => { if (value?.trim()) void submit(state, [value]); },
          onCancel: () => { void submit(state, null); },
        }));
        else if (Number.isInteger(option.value) && q.options[option.value]) {
          // Only a human's selected option reaches reply. Inspect is sent as
          // Inspect, so the server's one-use binding controls review delivery.
          void submit(state, [q.options[option.value].label]);
        }
      },
    }));
  };
  const poll = () => {
    if (disposed) return;
    const small = api.renderer?.width < 60 || api.renderer?.height < 24;
    if (active) {
      if (small || !pending(active.request)) close(active);
      return;
    }
    if (small) return;
    if (api.ui.dialog.open) return;
    const sessionID = currentSession();
    if (!sessionID) return;
    const request = api.state.session.question(sessionID)[0];
    // Multi-question and multi-select forms keep the client's native UI.
    if (!request || seen.has(request.id) || request.questions?.length !== 1) return;
    const q = request.questions[0];
    if (q.multiple || !Array.isArray(q.options) || !q.options.length || q.options.length > 8 ||
        q.options.some(option => typeof option.label !== "string" || option.label.length > 40) ||
        typeof q.question !== "string") return;
    seen.add(request.id);
    if (seen.size > 512) seen.delete(seen.values().next().value);
    const match = /^([^\n]+)\n\nCall preview \((\d+) characters\):\n/.exec(q.question);
    const length = match ? Number(match[2]) : 0;
    const tail = match ? q.question.slice(match[0].length + length) : "";
    const review = match && length > 0 && length <= 2000 &&
      q.question.length >= match[0].length + length &&
      (!tail || tail.startsWith("\n\nFull review:\n")) &&
      q.header === "Tool call" && q.options.every(option => ["Allow", "Deny", "Inspect"].includes(option.label));
    const text = review
      ? match[1] + "\n\n" + q.question.slice(match[0].length, match[0].length + length) + tail
      : q.question;
    active = { request, review, pages: pages(text), page: 0, transition: false, busy: false, done: false };
    show(active);
  };
  const timer = setInterval(poll, 200);
  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(timer);
    // Unloading an extension is not a human answer.
    if (active) close(active);
  });
  poll();
  return {};
}
`;
