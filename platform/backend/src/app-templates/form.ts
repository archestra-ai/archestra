import type { AppTemplate } from "@/types";

// A form wired to the App Data Store, so the author sees a complete read/write
// round-trip. The host injects window.__ARCHESTRA_APP_SDK_URL__ (the served
// ext-apps guest SDK); we import it, connect an App client, and expose
// window.archestra.data as a thin wrapper over the app_data_* tools — the API
// authors are documented against. No app_id is ever passed: the app's MCP
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
  <h1>Notes</h1>
  <form id="note-form">
    <textarea id="note" placeholder="Type a note — it persists in the app's data store."></textarea>
    <button type="submit" id="save">Save</button>
  </form>
  <div id="status" data-error="false"></div>

  <script type="module">
    const statusEl = document.getElementById("status");
    const setStatus = (msg, isError = false) => {
      statusEl.textContent = msg;
      statusEl.dataset.error = String(isError);
    };

    const sdkUrl = window.__ARCHESTRA_APP_SDK_URL__;
    if (!sdkUrl) {
      setStatus("Host did not provide the app SDK — data store unavailable.", true);
      throw new Error("missing __ARCHESTRA_APP_SDK_URL__");
    }

    const { App, PostMessageTransport } = await import(sdkUrl);
    const app = new App({ name: "archestra-app-form", version: "1.0.0" }, {});
    await app.connect(new PostMessageTransport(window.parent, window.parent));

    const call = (name, args) => app.callServerTool({ name, arguments: args });
    // The author-facing data API. Keys are app-scoped; values are any JSON.
    window.archestra = {
      data: {
        get: async (key) => (await call("archestra__app_data_get", { key })).structuredContent?.value,
        set: (key, value) => call("archestra__app_data_set", { key, value }),
        list: async () => (await call("archestra__app_data_list", {})).structuredContent?.entries ?? [],
        delete: (key) => call("archestra__app_data_delete", { key }),
      },
    };

    const noteEl = document.getElementById("note");
    const saveBtn = document.getElementById("save");

    const existing = await window.archestra.data.get("note");
    if (typeof existing === "string") noteEl.value = existing;
    setStatus("Ready.");

    document.getElementById("note-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      setStatus("Saving…");
      try {
        await window.archestra.data.set("note", noteEl.value);
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
  description: "A note form that reads and writes the app's data store.",
  html,
};
