import type { AppTemplate } from "@/types";

// The one opinionated starter for owned MCP Apps. Pure UI: the platform injects
// the baseline stylesheet (theme variables, themed element defaults, .arch-*
// components — all light/dark aware) and `window.archestra` (user identity,
// storage, tools, llm) at render time, so this document carries no SDK glue and
// no full theme. It demonstrates the two everyday SDK surfaces with worked,
// commented code: persistent per-viewer storage, and calling an assigned MCP
// tool via `archestra.tools.call`. Both stay graceful when nothing is wired up
// yet (storage starts empty; no tools assigned), so the scaffold runs as-is.
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My App</title>
  <!-- Theme variables, themed element defaults and .arch-* components come from
       the injected platform stylesheet; this app adds only its own layout. -->
  <style>
    body { max-width: 48rem; margin: 0 auto; padding: 1.5rem; }
    header { margin-bottom: 1.5rem; }
    header p { color: var(--color-text-secondary); margin: 0.25rem 0 0; }
    main { display: flex; flex-direction: column; gap: 1.5rem; }
    .field { display: flex; flex-direction: column; gap: 0.5rem; }
    .row { display: flex; gap: 0.5rem; align-items: center; }
    .muted { color: var(--color-text-secondary); font-size: 0.875rem; min-height: 1.25rem; }
    .muted[data-error="true"] { color: var(--color-text-danger); }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  </style>
</head>
<body>
  <header>
    <h1 id="greeting">My App</h1>
    <p>A starting point — edit this HTML to build your interface.</p>
  </header>

  <main>
    <!-- Persistent storage: writes survive reloads and are private to each
         viewer. Use archestra.storage.shared for state every viewer sees. -->
    <section class="arch-card field">
      <label class="field" for="note">
        <strong>Your note</strong>
        <textarea id="note" class="arch-input" rows="3"
          placeholder="Type something — it persists in your private app storage."></textarea>
      </label>
      <div class="row">
        <button id="save" class="arch-btn arch-btn--primary" type="button">Save</button>
        <span id="storage-status" class="muted" data-error="false"></span>
      </div>
    </section>

    <!-- Assigned MCP tools: call them as the viewer with their credentials.
         Assign tools to this app first; archestra.tools.list() reports them. -->
    <section class="arch-card field">
      <strong>Assigned tools</strong>
      <div class="row">
        <button id="run-tool" class="arch-btn arch-btn--ghost" type="button">Call first tool</button>
        <span id="tool-status" class="muted" data-error="false"></span>
      </div>
      <pre id="tool-output" class="muted"></pre>
    </section>
  </main>

  <script type="module">
    const $ = (id) => document.getElementById(id);
    const setStatus = (el, message, isError = false) => {
      el.textContent = message;
      el.dataset.error = String(isError);
    };

    // window.archestra is available synchronously, but the host handshake is
    // async — await archestra.ready before the first SDK call.
    await window.archestra.ready;

    // archestra.user is the authenticated viewer; no login flow is needed.
    if (window.archestra.user) {
      $("greeting").textContent = "Hello, " + window.archestra.user.name;
    }

    // --- Persistent storage: load the saved note, then save on click. ---
    const noteEl = $("note");
    const storageStatus = $("storage-status");
    try {
      const saved = await window.archestra.storage.user.get("note");
      if (saved) noteEl.value = saved.value;
      setStatus(storageStatus, "Ready.");
    } catch (err) {
      setStatus(storageStatus, "Storage unavailable: " + (err?.message ?? String(err)), true);
    }
    $("save").addEventListener("click", async () => {
      setStatus(storageStatus, "Saving…");
      try {
        await window.archestra.storage.user.set("note", noteEl.value);
        setStatus(storageStatus, "Saved.");
      } catch (err) {
        setStatus(storageStatus, "Save failed: " + (err?.message ?? String(err)), true);
      }
    });

    // --- Calling an assigned MCP tool with archestra.tools.call. ---
    const toolStatus = $("tool-status");
    const toolOutput = $("tool-output");
    const tools = await window.archestra.tools.list();
    if (tools.length === 0) {
      setStatus(toolStatus, "No tools assigned yet — assign one to call it here.");
      $("run-tool").disabled = true;
    } else {
      setStatus(toolStatus, "Assigned: " + tools.map((t) => t.name).join(", "));
    }
    $("run-tool").addEventListener("click", async () => {
      const [tool] = tools;
      setStatus(toolStatus, "Calling " + tool.name + "…");
      try {
        // Pass the tool name exactly as tools.list() returns it. Most tools take
        // arguments — read tool.inputSchema and fill them in for your use case.
        const result = await window.archestra.tools.call(tool.name, {});
        toolOutput.textContent = JSON.stringify(result, null, 2);
        setStatus(toolStatus, "Done.");
      } catch (err) {
        // A tool whose MCP server needs connecting rejects with
        // { code: "auth_required", url } — surface the url so the user can connect.
        if (err?.code === "auth_required" && err.url) {
          setStatus(toolStatus, "Connect the tool's server first: " + err.url, true);
        } else {
          setStatus(toolStatus, "Call failed: " + (err?.message ?? String(err)), true);
        }
      }
    });
  </script>
</body>
</html>`;

export const defaultTemplate: AppTemplate = {
  id: "default",
  name: "Starter",
  description:
    "A polished starter wired to persistent storage and assigned MCP tools.",
  html,
};
