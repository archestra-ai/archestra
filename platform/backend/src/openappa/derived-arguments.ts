import { isDeepStrictEqual } from "node:util";
import {
  type ArchestraToolShortName,
  ResourcePermissionGrantSchema,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { withoutArgumentCopies } from "./command-normalization";

/**
 * The call's arguments with the string array OpenAPPA rules an argument
 * holding an array of objects by, since no selector reads one:
 * `initialGrantPrincipals` (`<type>:<id>`, or `organization`) from
 * `initialGrants` for an Archestra tool that shares a resource, and
 * `transferModes` (`value` or `link`) from `environment` for a credential
 * transfer. A value sent under the derived name is replaced. A malformed
 * source derives `null`, which the battery's parameter schema refuses.
 */
export function withDerivedArguments(toolName: string, args: unknown): unknown {
  const key = derivedArgumentOf(toolName);
  if (key === null || !isRecord(args)) return args;
  const { [key]: _sent, ...rest } = args;
  const value = derivedValue(args, key);
  return value === undefined ? rest : { ...rest, [key]: value };
}

/**
 * A reviewed call's arguments without the copies the proxy rules it with:
 * `withoutArgumentCopies`, and the array `withDerivedArguments` derives for
 * this tool. Another tool keeps every argument it was sent.
 */
export function withoutProxyCopies(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const shown = withoutArgumentCopies(toolName, args);
  const key = derivedArgumentOf(toolName);
  if (
    key === null ||
    !Object.hasOwn(shown, key) ||
    !isDeepStrictEqual(shown[key], derivedValue(shown, key))
  )
    return shown;
  const { [key]: _derived, ...rest } = shown;
  return rest;
}

// ===

const DERIVED_ARGUMENTS = {
  initialGrantPrincipals: { source: "initialGrants", entry: grantPrincipal },
  transferModes: {
    source: "environment",
    entry: (variable: unknown) =>
      isRecord(variable)
        ? variable.value === undefined
          ? "link"
          : "value"
        : null,
  },
} as const;

type DerivedArgument = keyof typeof DERIVED_ARGUMENTS;

const GRANTING_TOOLS = new Set<ArchestraToolShortName | null>([
  "create_agent",
  "create_mcp_gateway",
  "create_mcp_server",
  "create_plugin",
  "create_knowledge_base",
  "scaffold_app",
]);

/** The argument derived for a tool, called or in canonical `mcp/<server>/<tool>` form. */
function derivedArgumentOf(toolName: string): DerivedArgument | null {
  const canonical = /^mcp\/([^/]+)\/([^/]+)$/.exec(toolName);
  const shortName = archestraMcpBranding.getToolShortName(
    canonical ? `${canonical[1]}__${canonical[2]}` : toolName,
  );
  if (shortName === "transfer_credential") return "transferModes";
  return GRANTING_TOOLS.has(shortName) ? "initialGrantPrincipals" : null;
}

/** One entry per source element, `null` if any is malformed; absent for none. */
function derivedValue(
  args: Record<string, unknown>,
  key: DerivedArgument,
): string[] | null | undefined {
  const { source, entry } = DERIVED_ARGUMENTS[key];
  const elements = args[source];
  if (
    elements === undefined ||
    (Array.isArray(elements) && elements.length === 0)
  )
    return undefined;
  const entries = Array.isArray(elements) ? elements.map(entry) : [null];
  return entries.every((value) => value !== null) ? entries : null;
}

/** A grant the tool would accept, as its principal; null for any other. */
function grantPrincipal(grant: unknown): string | null {
  const parsed = ResourcePermissionGrantSchema.safeParse(grant);
  if (!parsed.success) return null;
  const { subject } = parsed.data;
  return subject.type === "organization"
    ? "organization"
    : `${subject.type}:${subject.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
