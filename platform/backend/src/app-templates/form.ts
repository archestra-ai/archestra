import type { AppTemplate } from "@/types";

// A form wired to the App Data Store, demonstrating the Apps SDK the platform
// injects into every owned app (see services/apps/app-sdk-injection.ts):
// viewer identity via `archestra.user` and a complete read/write round-trip
// through `archestra.storage.user` (private to each viewer; use
// `archestra.storage.shared` for state all users of the app see). Pure UI: no
// SDK import, no transport wiring. No app_id is ever passed: the app's MCP
// endpoint is route-bound, so the store is always this app's own.
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Notes</title>
  <style>
    body { font-family: var(--font-sans, system-ui, sans-serif); margin: 0; padding: 2rem; color: var(--color-text-primary, #111); }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; }
    form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 32rem; }
    textarea { font: inherit; padding: 0.5rem; border: 1px solid var(--color-border-primary, #ccc); border-radius: var(--border-radius-md, 6px); min-height: 6rem; }
    button { font: inherit; padding: 0.5rem 1rem; border: none; border-radius: var(--border-radius-md, 6px); background: var(--color-background-inverse, #111); color: var(--color-text-inverse, #fff); cursor: pointer; align-self: flex-start; }
    button:disabled { opacity: 0.5; cursor: default; }
    #status { color: var(--color-text-secondary, #666); font-size: 0.875rem; min-height: 1.25rem; }
    #status[data-error="true"] { color: var(--color-text-danger, #c00); }
  </style>
</head>
<body>
  <h1 id="title">Notes</h1>
  <form id="note-form">
    <textarea id="note" placeholder="Type a note — it persists in your private partition of the app's data store."></textarea>
    <button type="submit" id="save">Save</button>
  </form>
  <div id="status" data-error="false"></div>

  <script type="module">
    const statusEl = document.getElementById("status");
    const setStatus = (msg, isError = false) => {
      statusEl.textContent = msg;
      statusEl.dataset.error = String(isError);
    };

    const noteEl = document.getElementById("note");
    const saveBtn = document.getElementById("save");

    // archestra.user is the authenticated viewer — no login flow needed.
    if (window.archestra.user) {
      document.getElementById("title").textContent =
        window.archestra.user.name + "'s notes";
    }

    try {
      const existing = await window.archestra.storage.user.get("note");
      if (typeof existing === "string") noteEl.value = existing;
      setStatus("Ready.");
    } catch (err) {
      setStatus("Data store unavailable: " + (err?.message ?? String(err)), true);
      throw err;
    }

    document.getElementById("note-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      setStatus("Saving…");
      try {
        await window.archestra.storage.user.set("note", noteEl.value);
        setStatus("Saved.");
      } catch (err) {
        setStatus("Save failed: " + (err?.message ?? String(err)), true);
      } finally {
        saveBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

export const formTemplate: AppTemplate = {
  id: "form",
  name: "Form with data store",
  description:
    "A personalized note form that reads and writes the viewer's data store partition.",
  html,
};
