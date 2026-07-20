import { AppModel, AppToolModel, McpServerModel } from "@/models";
import { callerIsAppAdmin } from "@/services/apps/app-authorization";
import { sanitizeAppNameForToolMetadata } from "@/services/apps/app-run-link";

/**
 * The app a chat is open with, resolved for the system prompt. One shape per
 * app family, because the two give the model genuinely different affordances:
 * an owned app is something it authors, an external one is a set of tools it
 * calls. `agents/agent-system-prompt.ts` renders each into its own block.
 */
export type OpenedApp =
  | {
      kind: "owned";
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
  openedApp: { appId: string | null; appMcpServerId: string | null };
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
    if (!app) return undefined;
    const name = promptSafe(app.name);
    // A name that sanitizes away leaves nothing to call the app by, so there is
    // no block worth writing.
    if (!name) return undefined;
    const tools = await AppToolModel.getToolsForApp(app.id);
    return {
      kind: "owned",
      name,
      description: promptSafe(app.description),
      // Sorted so the block is byte-stable across turns: assignment order is
      // arbitrary, and a list that reshuffles would break prompt caching.
      tools: tools.map((tool) => tool.name).sort(),
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
