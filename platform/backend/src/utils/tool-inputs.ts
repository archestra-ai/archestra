/**
 * Whether calling the tool with input `{}` cannot succeed: its input schema
 * declares required properties. Mirrors `normalizeToolInputSchema`
 * (routes/mcp-gateway.utils.ts): anything that isn't a `type: "object"` schema
 * normalizes to an empty object schema, i.e. no required inputs. Decides
 * render-vs-prompt mode for external app opens and the `requiresInput` flag on
 * the Apps listing.
 */
export function toolRequiresInputs(parameters: unknown): boolean {
  if (
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    return false;
  }
  const schema = parameters as { type?: unknown; required?: unknown };
  if (schema.type !== "object") return false;
  return Array.isArray(schema.required) && schema.required.length > 0;
}
