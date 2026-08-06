import { TOOL_SEARCH_FILES_SHORT_NAME } from "@archestra/shared";
import { AppModel, AppToolModel, McpServerModel } from "@/models";
import { callerIsAppAdmin } from "@/services/apps/app-authorization";
import { sanitizeAppNameForToolMetadata } from "@/services/apps/app-run-link";
import { isAppRuntimeBuiltinAvailable } from "@/services/apps/app-tool-runtime-gate";
import { fileStore } from "@/skills-sandbox/file-store";

/**
 * The app a chat is open with, resolved for the system prompt. One shape per
 * app family, because the two give the model genuinely different affordances:
 * an owned app is something it authors, an external one is a set of tools it
 * calls. `agents/agent-system-prompt.ts` renders each into its own block.
 */
export type OpenedApp =
  | {
      kind: "owned";
      /**
       * The app's id, carried so the chat can thread it into the tool-execution
       * context (`ArchestraContext.openedAppId`) for the agent-side file
       * exchange. Safe to trust: `resolveOpenedApp` re-verified the viewer's
       * access to exactly this id on this turn.
       */
      id: string;
      name: string;
      description: string | null;
      /**
       * The tools assigned to the app — what it is actually built on, and the
       * only way the model can learn them. An owned app *calls* tools rather
       * than being them, so it exposes nothing under its own name but the tool
       * that renders it: searching its namespace finds one `<slug>__open` and
       * no capabilities. Names are safe verbatim — every write to `tools.name`
       * goes through `ToolModel.slugifyName`, which strips everything outside
       * `[a-z0-9_-]`, so a name cannot break out of the sentence holding it.
       */
      tools: string[];
      /**
       * The app's per-viewer file store, listed server-side so the model knows
       * what the open app holds without being asked to go look. Empty when the
       * deployment runs without the sandbox runtime (no file store) — the
       * prompt block then says nothing about files at all.
       */
      files: { filename: string; sizeBytes: number }[];
      /**
       * Whether the deployment has a file store at all; distinguishes "no
       * files" (worth stating) from "no file feature" (say nothing).
       */
      hasFileStore: boolean;
      /**
       * What the running app last reported it is showing (via the MCP-Apps
       * update-model-context request), sanitized to one prompt-safe line.
       * App-authored and viewer-relayed — quoted strictly as data.
       */
      reportedContext: string | null;
    }
  | {
      kind: "external";
      name: string;
      description: string | null;
      /**
       * The `<slug>__` prefix this app's tools are stored under, or null when
       * it can't be read off a stored name. Null drops the tool guidance rather
       * than guessing a prefix — a wrong namespace is worse than none, since
       * the model would search for tools that don't exist.
       */
      toolNamespace: string | null;
    };

/**
 * Resolve an app for injection into a chat turn's system prompt, from the
 * identifier the chat UI reports as currently open. The reference is an
 * untrusted client hint, so the access check re-runs here every turn: an app
 * the caller cannot see — or one since deleted or made inaccessible — resolves
 * to undefined and simply drops the injection rather than leaking anything.
 */
export async function resolveOpenedApp(params: {
  openedApp: {
    appId: string | null;
    appMcpServerId: string | null;
    /** App-reported display state off the message metadata (untrusted). */
    modelContext?: string | null;
  };
  userId: string;
  organizationId: string;
}): Promise<OpenedApp | undefined> {
  const { openedApp, userId, organizationId } = params;

  if (openedApp.appId) {
    const app = await AppModel.findByIdForCaller({
      id: openedApp.appId,
      organizationId,
      userId,
      isAppAdmin: await callerIsAppAdmin(userId, organizationId),
    });
    // A disabled app must not reach the model at all (T-980) — dropping the
    // injection here matches the chat tools, which report it as not found.
    if (!app || !app.enabled) return undefined;
    const name = promptSafe(app.name);
    // A name that sanitizes away leaves nothing to call the app by, so there is
    // no block worth writing.
    if (!name) return undefined;
    // Availability comes from the same predicate the runtime gate, dispatch,
    // and SDK bootstrap ask, and the inventory from the same listing the
    // app-scope search_files runs — so what the prompt claims about the store
    // can never disagree with what the tools would actually return.
    const hasFileStore = isAppRuntimeBuiltinAvailable(
      TOOL_SEARCH_FILES_SHORT_NAME,
    );
    const [tools, fileItems] = await Promise.all([
      AppToolModel.getToolsForApp(app.id),
      hasFileStore
        ? fileStore.search({
            organizationId,
            userId,
            scope: { kind: "app", appId: app.id },
          })
        : Promise.resolve([]),
    ]);
    return {
      kind: "owned",
      id: app.id,
      name,
      description: promptSafe(app.description),
      // Sorted so the block is byte-stable across turns: assignment order is
      // arbitrary, and a list that reshuffles would break prompt caching.
      tools: tools.map((tool) => tool.name).sort(),
      // Filenames are user/app-authored text — sanitized like every other app
      // string that reaches the prompt. Sorted for byte-stability too.
      files: fileItems
        .flatMap((item) => {
          const filename = promptSafe(item.filename);
          return filename ? [{ filename, sizeBytes: item.sizeBytes ?? 0 }] : [];
        })
        .sort((a, b) => a.filename.localeCompare(b.filename)),
      hasFileStore,
      reportedContext: promptSafe(openedApp.modelContext ?? null),
    };
  }

  if (openedApp.appMcpServerId) {
    const identity = await McpServerModel.findUiAppIdentityForCaller({
      userId,
      mcpServerId: openedApp.appMcpServerId,
    });
    if (!identity) return undefined;
    const name = promptSafe(identity.serverName);
    return name
      ? {
          kind: "external",
          name,
          description: promptSafe(identity.serverDescription),
          toolNamespace: identity.toolNamespace,
        }
      : undefined;
  }

  return undefined;
}

// === internal ===

/**
 * Longest app description to carry into the prompt. Descriptions are a one-line
 * summary by intent but nothing enforces that, and this block is re-injected on
 * every turn.
 */
const DESCRIPTION_MAX_LENGTH = 500;

/**
 * An app's own text, made safe to place in the system prompt. Name and
 * description are user-authored free text, and an app can be shared across an
 * organization — so without this, one user's app could write into another
 * user's *trusted instruction channel*, where a single newline is enough to
 * append a forged paragraph. The tool-metadata sanitizer is exactly the right
 * transformation here (the system prompt is a plaintext context, so the
 * markdown-escaping variant would only show the model stray backslashes): it
 * collapses control, format, and whitespace runs, leaving one readable line
 * that cannot break out of its sentence or bidi-spoof it.
 */
function promptSafe(value: string | null): string | null {
  if (value === null) return null;
  const safe = sanitizeAppNameForToolMetadata(value).slice(
    0,
    DESCRIPTION_MAX_LENGTH,
  );
  return safe === "" ? null : safe;
}
