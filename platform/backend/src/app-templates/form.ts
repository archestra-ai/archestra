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
  <!-- Theme variables, element defaults and .arch-* components come from the
       platform baseline stylesheet; this app adds only its own layout. -->
  <style>
    form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 32rem; }
    textarea { min-height: 6rem; }
    button { align-self: flex-start; }
    #status { color: var(--color-text-secondary); font-size: 0.875rem; min-height: 1.25rem; }
    #status[data-error="true"] { color: var(--color-text-danger); }
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
