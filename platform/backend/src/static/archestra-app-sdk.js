/**
 * Archestra Apps SDK v1 — the client microframework injected into every owned
 * MCP App at serve time (see services/apps/app-sdk-injection.ts).
 *
 * Apps author pure UI against `window.archestra`:
 *   archestra.ready                 — promise; resolves when the host handshake completes
 *   archestra.user                  — { id, name } of the authenticated viewer (auto-auth)
 *   archestra.storage.user.*        — get/set/list/delete, private to the viewer
 *   archestra.storage.shared.*      — get/set/list/delete, shared by all users of the app
 *     (values are plain JSON; get(key) resolves to an entry { value, revision,
 *     owner } or null when absent, list() to [{key, value, revision, owner}];
 *     set(key, value, { ifRevision, owned }) resolves to { revision, owner } and
 *     rejects with { code: "conflict" } on a stale ifRevision or
 *     { code: "forbidden" } on an owned-key violation; delete clears a key)
 *   archestra.llm.complete(prompt, opts) — one host LLM completion (opts: { system, jsonMode });
 *                                     resolves to the text, rejects with { code: "llm_quota" }
 *                                     on a usage limit or { code: "llm_unavailable" } otherwise
 *   archestra.llm.prompt`...`       — tagged-template prompt builder (pure string, no round-trip)
 *   archestra.tools.call(name,args) — call an assigned tool with the viewer's credentials;
 *                                     throws { code: "auth_required", url } when the
 *                                     upstream MCP server needs (re)authentication
 *   archestra.tools.list()          — the app's assigned tools (name/description/inputSchema)
 *   archestra.ui.openLink(url) / archestra.ui.requestDisplayMode(mode)
 *   archestra.context               — { appId, version } of the running app (sync)
 *
 * Delivery contract (both globals are injected before this file loads):
 *   window.__ARCHESTRA_APP_CONTEXT__  — per-viewer bootstrap { user, tools, appId, version, sdkUrl } (backend)
 *   window.__ARCHESTRA_APP_SDK_URL__  — ext-apps guest SDK bundle URL (sandbox proxy, same-origin fallback)
 *   (the bundle URL is read from context.sdkUrl first, so a foreign host needs no proxy global)
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
  const formatConsoleArgs = (args) =>
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
      .join(" ");
  // console.error is always reported (it's a failure signal). console.log/warn/
  // info are reported too — so the authoring model can see what the app logged —
  // but throttled per second so a chatty render can't crowd out real errors.
  let logBudget = 10;
  let logWindowStart = Date.now();
  const hookConsole = (level, errorType, throttled) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      if (throttled) {
        const now = Date.now();
        if (now - logWindowStart > 1000) {
          logBudget = 10;
          logWindowStart = now;
        }
        if (logBudget <= 0) return;
        logBudget--;
      }
      postDiagnostic(errorType, formatConsoleArgs(args));
    };
  };
  hookConsole("error", "console.error", false);
  hookConsole("warn", "console.warn", true);
  hookConsole("info", "console.info", true);
  hookConsole("log", "console.log", true);

  const context = window.__ARCHESTRA_APP_CONTEXT__ || {};

  const connectPromise = (async () => {
    // A strict foreign host (claude.ai) refuses any cross-origin <script src>,
    // so the connector inlines the ext-apps bundle ahead of this script and
    // exposes it as a global — prefer it and never touch the network. Otherwise
    // (Archestra's own render) import it from the platform origin the host's CSP
    // allows.
    let App;
    let PostMessageTransport;
    const preloaded = window.__ARCHESTRA_EXT_APPS__;
    if (preloaded && preloaded.App && preloaded.PostMessageTransport) {
      ({ App, PostMessageTransport } = preloaded);
    } else {
      const sdkUrl = context.sdkUrl || window.__ARCHESTRA_APP_SDK_URL__;
      if (!sdkUrl) {
        throw new Error(
          "Archestra Apps SDK: host did not provide the guest SDK URL",
        );
      }
      ({ App, PostMessageTransport } = await import(sdkUrl));
    }
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

  // A connect that neither resolves nor rejects means the host accepted our
  // postMessage but never answered ui/initialize — its sandbox doesn't relay to
  // an MCP-Apps bridge (a wrapper/proxy frame, or a non-conformant host). That
  // failure is otherwise invisible (the app just sees a forever-pending ready),
  // so surface it as a diagnostic. A resolve or reject cancels it.
  const HANDSHAKE_TIMEOUT_MS = 10000;
  const handshakeTimer = setTimeout(() => {
    postDiagnostic(
      "error",
      "host handshake (ui/initialize) did not complete within " +
        HANDSHAKE_TIMEOUT_MS +
        "ms — the host may not relay postMessage to its MCP-Apps bridge",
    );
  }, HANDSHAKE_TIMEOUT_MS);
  connectPromise.then(
    () => clearTimeout(handshakeTimer),
    () => clearTimeout(handshakeTimer),
  );

  // Canonical built-in tool names. Kept in sync with @archestra/shared
  // constants by a backend drift-guard test (app-sdk-injection.test.ts).
  const APP_DATA_TOOLS = {
    get: "archestra__app_data_get",
    set: "archestra__app_data_set",
    list: "archestra__app_data_list",
    delete: "archestra__app_data_delete",
  };
  const LLM_COMPLETE_TOOL = "archestra__llm_complete";

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
      // Storage writes surface optimistic-concurrency and ownership rejections,
      // and llm.complete surfaces quota/unavailable, as typed codes so apps can
      // branch (retry on conflict, warn on forbidden, back off on llm_quota)
      // instead of parsing a message string.
      if (
        platformError &&
        (platformError.type === "conflict" ||
          platformError.type === "forbidden" ||
          platformError.type === "llm_quota" ||
          platformError.type === "llm_unavailable")
      ) {
        throw Object.assign(
          new Error(
            textOf(result) ||
              platformError.message ||
              'Tool "' + name + '" was rejected',
          ),
          { code: platformError.type },
        );
      }
      throw Object.assign(
        new Error(textOf(result) || 'Tool "' + name + '" failed'),
        { code: "tool_error" },
      );
    }
    return result;
  };

  // Each value is an entry { value, revision, owner }: revision powers optimistic
  // concurrency (pass it back as set opts.ifRevision to fail a write that raced
  // another viewer — the call rejects with { code: "conflict" }); owner is the
  // viewer id that claimed the (shared) key, or null when unclaimed. delete is
  // guarded by ownership rather than revision.
  const storagePartition = (scope) =>
    Object.freeze({
      get: async (key) => {
        const sc = (await callTool(APP_DATA_TOOLS.get, { key, scope }))
          .structuredContent;
        return sc && sc.revision != null
          ? { value: sc.value, revision: sc.revision, owner: sc.owner ?? null }
          : null;
      },
      // opts.ifRevision: write only if the stored revision matches (0 = create,
      // i.e. fail if the key already exists). opts.owned: claim a new shared key
      // for the viewer so only they (or the app's author/admins) may overwrite it.
      set: async (key, value, opts) => {
        const sc = (
          await callTool(APP_DATA_TOOLS.set, {
            key,
            value,
            scope,
            expectedRevision: opts?.ifRevision,
            claimOwner: opts?.owned,
          })
        ).structuredContent;
        return { revision: sc?.revision, owner: sc?.owner ?? null };
      },
      list: async () =>
        (await callTool(APP_DATA_TOOLS.list, { scope })).structuredContent
          ?.entries || [],
      // delete is guarded by ownership (an owned shared key can only be removed
      // by its owner or the app's author/admins), not by revision.
      delete: async (key) => {
        await callTool(APP_DATA_TOOLS.delete, { key, scope });
      },
    });

  // A single host LLM completion. Runs as the viewer through the org's app
  // runtime model (the app can't pick one); jsonMode steers the model to emit
  // a single JSON value the app then parses. Rejects with { code: "llm_quota" }
  // when usage limits are hit and { code: "llm_unavailable" } otherwise.
  const llmComplete = async (prompt, opts) => {
    const result = await callTool(LLM_COMPLETE_TOOL, {
      prompt,
      system: opts && opts.system,
      jsonMode: opts && opts.jsonMode,
    });
    return textOf(result);
  };

  // Tagged-template prompt builder (Spark's llmPrompt): interpolates values into
  // a plain string. A pure client helper — no host round-trip.
  const llmPrompt = (strings, ...values) =>
    strings.reduce(
      (out, str, i) =>
        out + str + (i < values.length ? String(values[i]) : ""),
      "",
    );

  window.archestra = Object.freeze({
    ready,
    user: Object.freeze(context.user || null),
    storage: Object.freeze({
      user: storagePartition("user"),
      shared: storagePartition("app"),
    }),
    llm: Object.freeze({
      complete: llmComplete,
      prompt: llmPrompt,
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
    // Read-only app metadata so an app can reference itself (e.g. build a link
    // to its own run page, show its version). Injected at serve time.
    context: Object.freeze({
      appId: context.appId || null,
      version: context.version ?? null,
    }),
  });

  // Best-effort render screenshot. The host can't capture the app (the iframe is
  // cross-origin), so the app self-captures its own DOM and posts it to the
  // parent, which forwards it to the server to feed get_app_diagnostics — letting
  // the authoring model see how the app actually looks. The capture library is
  // pulled lazily from the platform CDN allowlist (script-src, not the blocked
  // connect-src). Never blocks or breaks the app; any failure is silent.
  const loadCaptureLib = () =>
    new Promise((resolve, reject) => {
      if (window.html2canvas) return resolve(window.html2canvas);
      const s = document.createElement("script");
      s.src =
        "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error("capture lib failed to load"));
      document.head.appendChild(s);
    });
  const captureRenderScreenshot = async () => {
    try {
      if (!document.body) return;
      const html2canvas = await loadCaptureLib();
      if (typeof html2canvas !== "function") return;
      const canvas = await html2canvas(document.body, {
        scale: 0.5,
        logging: false,
        backgroundColor: null,
        useCORS: true,
      });
      const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      // ~1.1MB of binary once base64 is decoded; the ingest endpoint caps too.
      if (dataUrl.length > 1_500_000) return;
      window.parent.postMessage(
        {
          type: "mcp-apps:screenshot",
          version: context.version ?? null,
          dataUrl,
        },
        "*",
      );
    } catch {
      // diagnostics are best-effort; never surface a capture failure to the app
    }
  };
  // Only the author captures (they read it back via get_app_diagnostics); other
  // viewers skip it entirely — no third-party lib load, no DOM rasterize. Wait
  // for the handshake, then give the app a beat to paint before capturing.
  if (context.captureScreenshot) {
    ready
      .then(() => {
        setTimeout(captureRenderScreenshot, 1500);
      })
      .catch(() => {});
  }
})();
