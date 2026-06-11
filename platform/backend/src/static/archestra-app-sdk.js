/**
 * Archestra Apps SDK v1 — the client microframework injected into every owned
 * MCP App at serve time (see services/apps/app-sdk-injection.ts).
 *
 * Apps author pure UI against `window.archestra`:
 *   archestra.ready                 — promise; resolves when the host handshake completes
 *   archestra.user                  — { id, name } of the authenticated viewer (auto-auth)
 *   archestra.storage.user.*        — get/set/list/delete, private to the viewer
 *   archestra.storage.shared.*      — get/set/list/delete, shared by all users of the app
 *     (values are plain JSON: get returns exactly what set stored, or null when
 *     absent — set rejects top-level null, delete clears a key; list() returns
 *     [{key, value}] entries, not keys)
 *   archestra.tools.call(name,args) — call an assigned tool with the viewer's credentials;
 *                                     throws { code: "auth_required", url } when the
 *                                     upstream MCP server needs (re)authentication
 *   archestra.tools.list()          — the app's assigned tools (name/description/inputSchema)
 *   archestra.ui.openLink(url) / archestra.ui.requestDisplayMode(mode)
 *   archestra.chat.sendMessage(text)
 *
 * Delivery contract (both globals are injected before this file loads):
 *   window.__ARCHESTRA_APP_SDK_URL__  — ext-apps guest SDK bundle URL (sandbox proxy)
 *   window.__ARCHESTRA_APP_CONTEXT__  — per-viewer bootstrap { user, tools } (backend)
 *
 * Classic (non-module) script: `window.archestra` exists synchronously before
 * any app script. Connects eagerly at load — the host only delivers
 * toolInput/toolResult after the guest handshake, so an app that never calls a
 * method must still complete it. Failure is loud: every method rejects with
 * the original connect error. This file must not use dynamic code generation
 * — the sandbox CSP forbids it and the violation listener only mutes the
 * ext-apps bundle's own probe.
 */
(() => {
  "use strict";

  // Render-loop diagnostics: runtime errors are posted to the parent (the
  // sandbox proxy forwards them to the host), where they are validated,
  // capped, and surfaced back to the authoring model. Same channel shape as
  // the proxy's CSP-violation forwarding. Never include viewer identity here:
  // diagnostics post with targetOrigin "*".
  const postDiagnostic = (errorType, message) => {
    try {
      window.parent.postMessage(
        {
          type: "mcp-apps:runtime-error",
          errorType,
          message: String(message).slice(0, 1000),
          timestamp: Date.now(),
        },
        "*",
      );
    } catch {
      // never let diagnostics reporting break the app
    }
  };
  window.addEventListener("error", (e) => {
    postDiagnostic(
      "error",
      e.message + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : ""),
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    postDiagnostic(
      "unhandledrejection",
      (r && (r.stack || r.message)) || String(r),
    );
  });
  const consoleError = console.error.bind(console);
  console.error = (...args) => {
    consoleError(...args);
    postDiagnostic(
      "console.error",
      args
        .map((a) => {
          if (a instanceof Error) return a.message;
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" "),
    );
  };

  const context = window.__ARCHESTRA_APP_CONTEXT__ || {};

  const connectPromise = (async () => {
    const sdkUrl = window.__ARCHESTRA_APP_SDK_URL__;
    if (!sdkUrl) {
      throw new Error(
        "Archestra Apps SDK: host did not provide the guest SDK URL",
      );
    }
    const { App, PostMessageTransport } = await import(sdkUrl);
    // the guest bundle observes document.body for size reporting at connect
    // time; a blocking <head> script (e.g. a CDN library) can let the
    // handshake win the race against <body> parsing, so wait for the DOM.
    // The readyState check keeps this hang-proof: once parsing is past
    // "loading" the event will never fire again.
    if (
      typeof document !== "undefined" &&
      !document.body &&
      document.readyState === "loading"
    ) {
      await new Promise((resolve) =>
        document.addEventListener("DOMContentLoaded", resolve, { once: true }),
      );
    }
    const app = new App({ name: "archestra-app-sdk", version: "1.0.0" }, {});
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    return app;
  })();
  connectPromise.catch((err) => {
    console.error("Archestra Apps SDK: connect failed", err);
  });
  const ready = connectPromise.then(() => undefined);
  // the connect failure is already reported above; don't double-report when an
  // app never awaits ready
  ready.catch(() => {});

  // Canonical built-in tool names. Kept in sync with @archestra/shared
  // constants by a backend drift-guard test (app-sdk-injection.test.ts).
  const APP_DATA_TOOLS = {
    get: "archestra__app_data_get",
    set: "archestra__app_data_set",
    list: "archestra__app_data_list",
    delete: "archestra__app_data_delete",
  };

  const textOf = (result) =>
    (result.content || [])
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join("\n");

  // Structured platform error attached to tool results (auth_required,
  // auth_expired, ...) — in _meta and mirrored in structuredContent.
  const archestraErrorOf = (result) =>
    (result._meta && result._meta.archestraError) ||
    (result.structuredContent && result.structuredContent.archestraError) ||
    null;

  /**
   * Call a tool and resolve with its result. Tool-level failures throw —
   * apps handle one error channel instead of checking isError:
   * - upstream MCP needs (re)auth → { code: "auth_required", url } so the app
   *   can render a "Connect" link (the user authenticates in the registry UI);
   * - any other tool error → { code: "tool_error" } with the error text.
   */
  const callTool = async (name, args) => {
    const app = await connectPromise;
    const result = await app.callServerTool({ name, arguments: args || {} });
    if (result.isError) {
      const platformError = archestraErrorOf(result);
      if (
        platformError &&
        (platformError.type === "auth_required" ||
          platformError.type === "auth_expired")
      ) {
        const url =
          platformError.actionUrl ||
          platformError.reauthUrl ||
          platformError.installUrl ||
          null;
        throw Object.assign(
          new Error(
            'Tool "' +
              name +
              '" requires authentication' +
              (url ? " — open " + url : ""),
          ),
          { code: "auth_required", url },
        );
      }
      throw Object.assign(
        new Error(textOf(result) || 'Tool "' + name + '" failed'),
        { code: "tool_error" },
      );
    }
    return result;
  };

  const storagePartition = (scope) =>
    Object.freeze({
      get: async (key) =>
        (await callTool(APP_DATA_TOOLS.get, { key, scope })).structuredContent
          ?.value,
      set: async (key, value) => {
        await callTool(APP_DATA_TOOLS.set, { key, value, scope });
      },
      list: async () =>
        (await callTool(APP_DATA_TOOLS.list, { scope })).structuredContent
          ?.entries || [],
      delete: async (key) => {
        await callTool(APP_DATA_TOOLS.delete, { key, scope });
      },
    });

  window.archestra = Object.freeze({
    ready,
    user: Object.freeze(context.user || null),
    storage: Object.freeze({
      user: storagePartition("user"),
      shared: storagePartition("app"),
    }),
    tools: Object.freeze({
      call: callTool,
      // assigned-tool descriptors embedded at serve time (already filtered to
      // what the app may call); async to allow a live listing later without an
      // API break
      list: async () => (context.tools || []).map((t) => ({ ...t })),
    }),
    ui: Object.freeze({
      openLink: async (url) => {
        await (await connectPromise).openLink({ url });
      },
      requestDisplayMode: async (mode) => {
        await (await connectPromise).requestDisplayMode({ mode });
      },
    }),
    chat: Object.freeze({
      sendMessage: async (text) => {
        await (await connectPromise).sendMessage({
          role: "user",
          content: [{ type: "text", text }],
        });
      },
    }),
  });
})();
