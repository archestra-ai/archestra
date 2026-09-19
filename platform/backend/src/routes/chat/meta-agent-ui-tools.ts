import { META_AGENT_UI_TOOL_NAMES } from "@archestra/shared";
import { type Tool, tool } from "ai";
import { z } from "zod";

/**
 * Tools the meta agent uses to drive the page the user has open.
 *
 * They are declared without `execute`: the AI SDK ends the step on such a
 * call and streams it to the browser, which runs it against the live DOM and
 * answers with `addToolOutput`; the next request resumes the turn. The browser
 * acts inside the user's own session, so these tools can do exactly what the
 * user could do by clicking — nothing the user's permissions would refuse.
 */
export function buildMetaAgentUiTools(): Record<string, Tool> {
  const refSchema = z
    .number()
    .int()
    .describe("The element's [ref] number from the latest page snapshot");

  return {
    [META_AGENT_UI_TOOL_NAMES.GET_PAGE]: tool({
      description:
        "Snapshot the page the user has open: its URL, title, visible text, and every interactive element tagged with a [ref] number the other browser tools act on. Take a fresh snapshot before acting whenever the page may have changed.",
      inputSchema: z.object({}),
    }),
    [META_AGENT_UI_TOOL_NAMES.NAVIGATE]: tool({
      description:
        "Open a page of this web app in the user's browser, by path (for example /agents or /settings/teams). Returns a snapshot of the new page.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("An app path starting with /, optionally with a query"),
      }),
    }),
    [META_AGENT_UI_TOOL_NAMES.CLICK]: tool({
      description:
        "Click an element on the user's page. Returns a snapshot of the page after the click.",
      inputSchema: z.object({ ref: refSchema }),
    }),
    [META_AGENT_UI_TOOL_NAMES.FILL]: tool({
      description:
        "Replace the value of a text input or textarea on the user's page. Returns a snapshot of the page afterwards.",
      inputSchema: z.object({
        ref: refSchema,
        value: z.string().describe("The full new value"),
      }),
    }),
    [META_AGENT_UI_TOOL_NAMES.PRESS_KEY]: tool({
      description:
        "Press a key on the user's page, for example Enter to submit or Escape to close a dialog. Sent to the given element, or to the focused element when ref is omitted. Returns a snapshot afterwards.",
      inputSchema: z.object({
        key: z.string().describe("A KeyboardEvent key value such as Enter"),
        ref: refSchema.optional(),
      }),
    }),
  };
}
