import {
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  toMcpClientServerName,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { resolveRunToolTargetName } from "@/archestra-mcp-server/run-tool-target";
import {
  type ToolAttestation,
  verifyToolAttestation,
} from "@/archestra-mcp-server/tool-attestation";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import { AgentModel, ToolModel } from "@/models";
import type { DeclaredToolSpelling } from "@/openappa/wire";
import type { GatewayToolDeclaration } from "./gateway-tool-declarations";

/**
 * Maps a tool name as the client presents it, with the Codex namespace it was
 * declared or called in, to the canonical name the platform knows it by.
 * Defined on wire spellings only: a name that is already canonical is not a
 * valid input.
 */
export type ToolNameCanonicalizer = (
  toolName: string,
  namespace?: string,
) => string;

export type ToolNameResolution = {
  canonicalize: ToolNameCanonicalizer;
  /**
   * True only in compat mode, where a `run_tool` wrapper may be recognized
   * behind a client label nothing proves is ours.
   */
  looseRunToolDispatch: boolean;
};

/** A declaration whose attestation marker verified, with what it attests. */
export type VerifiedToolDeclaration = DeclaredToolSpelling & ToolAttestation;

/**
 * Which of the tools a request names are this platform's gateway tools, and
 * which tool each one is.
 *
 * A client relabels an MCP server's tools before its model sees them: Claude
 * Code presents the advertised `A` as `mcp__<label>__A`, OpenCode as
 * `<label>_A`, Codex as member `A` of a `mcp__<label>` namespace, and Chat and
 * SDK callers send `A` itself. The label is whatever the person connecting the
 * client typed, so it proves nothing, and a hostile MCP server connected to
 * the same client can give its tools any name, ours included.
 *
 * What proves a declaration is ours is the attestation marker the gateway puts
 * in front of every description it serves (see `tool-attestation.ts`), which
 * `extractGatewayToolDeclarations` took out of the body. A marker that
 * verifies ties that exact declaration, its namespace and wire name, to the
 * name the gateway advertised, whatever the label. The mode says what the
 * request offered:
 *  - "attested": at least one marker verified. Attested declarations resolve
 *    to their advertised names; every other name keeps its own spelling, and
 *    one that would read as a built-in or as a tool a gateway serves is
 *    marked foreign.
 *  - "chat": the platform's own Chat before its tool list carries markers.
 *    Chat assembles that list from the gateway itself, so names are taken as
 *    they are.
 *  - "compat": no marker verified. The label-anchored resolution this
 *    replaces runs instead, until the next release deletes it.
 *
 * Every function here is a closure, so each can be passed on its own.
 */
export type GatewayToolIdentity = ToolNameResolution & {
  mode: "attested" | "compat" | "chat";
  /** Effective attestation, after demotion, of the exact (namespace, name). */
  attestationOf: (
    name: string,
    namespace?: string,
  ) => VerifiedToolDeclaration | undefined;
  /** The declaration that canonicalizes to `canonicalName`, when exactly one does. */
  spellingOf: (canonicalName: string) => DeclaredToolSpelling | undefined;
  /** Every declaration whose marker verified, before demotion. */
  verified: readonly VerifiedToolDeclaration[];
  /** Declarations whose marker did not verify. */
  unverifiedMarkerCount: number;
};

/**
 * Put in front of an unattested name that would otherwise read as one of the
 * platform's built-ins, or as a tool a gateway serves, so no strict built-in
 * check and no policy row downstream can match it.
 */
export const FOREIGN_TOOL_NAME_PREFIX = "foreign:";

/**
 * Resolves this request's tool identity from its declarations, once the
 * organization whose key verifies the markers is known.
 *
 * `internalChat` is the platform's own Chat over loopback: its unattested
 * names keep their identity, in either mode, because the platform assembled
 * its tool list.
 */
export async function resolveGatewayToolIdentity(params: {
  organizationId: string;
  declarations: readonly GatewayToolDeclaration[];
  internalChat: boolean;
}): Promise<GatewayToolIdentity> {
  const { organizationId, internalChat } = params;
  const declarations = dedupeDeclarations(params.declarations);
  const verified: VerifiedToolDeclaration[] = [];
  let unverifiedMarkerCount = 0;
  for (const { marker, ...spelling } of declarations) {
    if (!marker) continue;
    const attestation = verifyToolAttestation({ organizationId, marker });
    if (attestation) verified.push({ ...spelling, ...attestation });
    else unverifiedMarkerCount++;
  }

  if (verified.length > 0) {
    return await attestedIdentity({
      organizationId,
      declarations,
      verified,
      unverifiedMarkerCount,
      internalChat,
    });
  }
  if (internalChat) {
    return identityOf({
      mode: "chat",
      canonicalize: spelledName,
      effective: new Map(),
      declarations,
      verified,
      unverifiedMarkerCount,
    });
  }
  return await compatIdentity({
    organizationId,
    declarations,
    unverifiedMarkerCount,
  });
}

// === Internal helpers ===

/**
 * Attested mode. An effective attestation resolves its declaration to the
 * advertised name. Any other name keeps its spelling, namespaced names as
 * `<namespace>__<name>`, and one that would read as a built-in or as a tool a
 * gateway serves is marked {@link FOREIGN_TOOL_NAME_PREFIX foreign}. So
 * neither a label nor a namespace nor a bare name can confer built-in, control
 * or notice status, or a real tool's policy identity. No label is anchored and
 * no prefix is learned.
 */
async function attestedIdentity(params: {
  organizationId: string;
  declarations: readonly GatewayToolDeclaration[];
  verified: readonly VerifiedToolDeclaration[];
  unverifiedMarkerCount: number;
  internalChat: boolean;
}): Promise<GatewayToolIdentity> {
  const effective = new Map(
    params.verified.map((declaration) => [
      declarationKey(declaration.name, declaration.namespace),
      declaration,
    ]),
  );
  const demoted = demoteAttestations(effective);

  // Every declaration left without an effective attestation, as spelled.
  const unattested = params.declarations
    .filter(
      ({ name, namespace }) => !effective.has(declarationKey(name, namespace)),
    )
    .map(({ name, namespace }) => spelledName(name, namespace));
  // Chat's unattested names are the platform's own, so none is foreign.
  const servedToolNames = params.internalChat
    ? new Set<string>()
    : await gatewayServedToolNames({
        verified: params.verified,
        unattested,
      });
  const isLookalike = (spelled: string) =>
    isBuiltInLookalike(spelled) || servedToolNames.has(spelled);

  const canonicalize: ToolNameCanonicalizer = (name, namespace) => {
    const attestation = effective.get(declarationKey(name, namespace));
    if (attestation) return attestation.advertisedName;
    const spelled = spelledName(name, namespace);
    if (params.internalChat || !isLookalike(spelled)) return spelled;
    return `${FOREIGN_TOOL_NAME_PREFIX}${spelled}`;
  };

  const verifiedKeys = new Set(
    params.verified.map(({ name, namespace }) =>
      declarationKey(name, namespace),
    ),
  );
  // An unattested declaration that looks like ours is a foreign server
  // copying our names, or a client that dropped this one's description.
  // Chat's unattested names are the platform's own, so they are not listed.
  const lookalikes = params.internalChat
    ? []
    : params.declarations
        .filter(
          ({ name, namespace }) =>
            !verifiedKeys.has(declarationKey(name, namespace)),
        )
        .map(({ name, namespace }) => spelledName(name, namespace))
        .filter(
          (spelled) =>
            isLookalike(spelled) ||
            learnGatewayDecorationPrefixes([spelled]).length > 0,
        );
  if (
    demoted.length > 0 ||
    lookalikes.length > 0 ||
    params.unverifiedMarkerCount > 0
  ) {
    logger.warn(
      {
        organizationId: params.organizationId,
        demoted: demoted.map(({ declaration, reason }) => ({
          toolName: spelledName(declaration.name, declaration.namespace),
          advertisedName: declaration.advertisedName,
          gatewayId: declaration.gatewayId,
          reason,
        })),
        unattestedLookalikes: lookalikes,
        unverifiedMarkerCount: params.unverifiedMarkerCount,
      },
      "Gateway tool attestation: some declarations in this request are not treated as this platform's gateway tools",
    );
  }

  return identityOf({
    mode: "attested",
    canonicalize,
    effective,
    declarations: params.declarations,
    verified: params.verified,
    unverifiedMarkerCount: params.unverifiedMarkerCount,
  });
}

/**
 * Removes, in place, the attestations that cannot be taken at their word, and
 * returns what it removed and why.
 *
 * - replayed: the gateway advertises a name once, so the same (gateway, name)
 *   under two spellings is a replayed marker or the gateway registered twice
 *   in one client, and nothing says which spelling is the real one. Both go.
 *   The same name from two different gateways is two real tools and stays.
 * - branded_third_party: a tool the gateway did not serve as a built-in never
 *   reads as one.
 * - non_owner_built_in: when exactly one gateway attests the OpenAPPA remedy
 *   pair, built-ins from any other gateway go, so control and notice status
 *   come from a single gateway. With no single owner (OpenAPPA off, or two
 *   gateways that each serve the pair) built-ins from every gateway stay,
 *   which keeps two-gateway setups working. The residual: in that case a
 *   member can replay one gateway's built-in marker, leaked from a session
 *   that bypassed the proxy, next to another gateway, and it is accepted.
 */
function demoteAttestations(
  effective: Map<string, VerifiedToolDeclaration>,
): Array<{ declaration: VerifiedToolDeclaration; reason: DemotionReason }> {
  const demoted: Array<{
    declaration: VerifiedToolDeclaration;
    reason: DemotionReason;
  }> = [];
  const demote = (key: string, reason: DemotionReason) => {
    const declaration = effective.get(key);
    if (!declaration) return;
    effective.delete(key);
    demoted.push({ declaration, reason });
  };

  const spellingsByServedTool = new Map<string, string[]>();
  for (const [key, declaration] of effective) {
    const servedTool = `${declaration.gatewayId}\u0000${declaration.advertisedName}`;
    spellingsByServedTool.set(servedTool, [
      ...(spellingsByServedTool.get(servedTool) ?? []),
      key,
    ]);
  }
  for (const keys of spellingsByServedTool.values()) {
    if (keys.length < 2) continue;
    for (const key of keys) demote(key, "replayed");
  }

  for (const [key, declaration] of effective) {
    if (
      declaration.kind === "t" &&
      isBuiltInLookalike(declaration.advertisedName)
    ) {
      demote(key, "branded_third_party");
    }
  }

  const remedyToolsByGateway = new Map<string, Set<string>>();
  for (const declaration of effective.values()) {
    if (declaration.kind !== "b") continue;
    const shortName = archestraMcpBranding.getToolShortName(
      declaration.advertisedName,
    );
    if (
      shortName !== TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME &&
      shortName !== TOOL_GET_REMEDY_PLANS_SHORT_NAME
    ) {
      continue;
    }
    const tools = remedyToolsByGateway.get(declaration.gatewayId) ?? new Set();
    tools.add(shortName);
    remedyToolsByGateway.set(declaration.gatewayId, tools);
  }
  const pairOwners = [...remedyToolsByGateway]
    .filter(
      ([, tools]) =>
        tools.has(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME) &&
        tools.has(TOOL_GET_REMEDY_PLANS_SHORT_NAME),
    )
    .map(([gatewayId]) => gatewayId);
  if (pairOwners.length === 1) {
    for (const [key, declaration] of effective) {
      if (declaration.kind === "b" && declaration.gatewayId !== pairOwners[0]) {
        demote(key, "non_owner_built_in");
      }
    }
  }

  return demoted;
}

type DemotionReason = "replayed" | "branded_third_party" | "non_owner_built_in";

// Compat: delete next release (no valid attestation in the request).
async function compatIdentity(params: {
  organizationId: string;
  declarations: readonly GatewayToolDeclaration[];
  unverifiedMarkerCount: number;
}): Promise<GatewayToolIdentity> {
  const serverNames = await getGatewayServerNames(params.organizationId);
  const spelledDeclarations = params.declarations.map(({ name, namespace }) =>
    spelledName(name, namespace),
  );
  const learnedPrefixes = learnGatewayDecorationPrefixes(spelledDeclarations);
  // A namespaced name is always resolved as `<namespace>__<name>`, never by
  // its bare member name: any server's namespace can hold a member spelled
  // like one of ours.
  const canonicalize: ToolNameCanonicalizer = (name, namespace) =>
    compatCanonicalize({
      toolName: spelledName(name, namespace),
      serverNames,
      learnedPrefixes,
    });

  const branded = spelledDeclarations.filter((spelled) =>
    archestraMcpBranding.isToolName(spelled),
  );
  const logContext = {
    organizationId: params.organizationId,
    unverifiedMarkerCount: params.unverifiedMarkerCount,
    learnedPrefixes,
    toolNames: spelledDeclarations.filter((spelled) =>
      archestraMcpBranding.isLikelyToolName(spelled),
    ),
  };
  if (
    params.unverifiedMarkerCount > 0 ||
    learnedPrefixes.length > 0 ||
    branded.length > 0
  ) {
    logger.warn(
      logContext,
      "No gateway tool attestation verified in this request, so gateway tools are recognized by their client label (compat). Likely causes: the client dropped tool descriptions, its tool list was fetched before this deploy, or the tools come from a server that is not this platform's gateway",
    );
  } else {
    logger.debug(
      logContext,
      "No gateway tool attestation in this request; resolving tool names by client label (compat)",
    );
  }

  return identityOf({
    mode: "compat",
    canonicalize,
    effective: new Map(),
    declarations: params.declarations,
    verified: [],
    unverifiedMarkerCount: params.unverifiedMarkerCount,
  });
}

/**
 * Compat: maps a client-decorated name to the platform's own when its label
 * is the client server name of one of the organization's gateway-capable
 * agents (`toMcpClientServerName`), or a prefix this request's own tool list
 * puts in front of a branded name ({@link learnGatewayDecorationPrefixes}).
 *
 * A label is not proof: a server connected straight to the client can take
 * one, which is why attested requests never come here. Behind Claude Code's
 * fixed `mcp` prefix, a bare built-in short name left after stripping is
 * expanded to its full name, as run_tool resolves it. A label in first
 * position must leave a `<server>__<tool>` name behind and is never expanded,
 * so an ordinary `filesystem__read_file` is not taken for
 * `archestra__read_file` because a gateway is named Filesystem.
 */
function compatCanonicalize(params: {
  toolName: string;
  serverNames: ReadonlySet<string>;
  learnedPrefixes: readonly string[];
}): string {
  const { toolName, serverNames, learnedPrefixes } = params;
  const segments = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
  // The gateway's server-name label sits first, or second behind a fixed
  // client prefix (Claude Code's `mcp`). Require at least one segment after
  // the label to form the canonical name.
  const labelLimit = Math.min(GATEWAY_LABEL_MAX_INDEX + 1, segments.length - 1);
  for (let i = 0; i < labelLimit; i++) {
    if (!serverNames.has(segments[i])) {
      continue;
    }
    const remainder = segments
      .slice(i + 1)
      .join(MCP_SERVER_TOOL_NAME_SEPARATOR);
    if (i === 0) {
      if (!remainder.includes(MCP_SERVER_TOOL_NAME_SEPARATOR)) {
        continue;
      }
      return remainder;
    }
    return resolveRunToolTargetName(remainder);
  }
  // OpenCode joins its label to the advertised name with a single
  // underscore (`<label>_<server>__<tool>`), so the label is not a segment of
  // its own. Every gateway tool name carries the `<server>__<tool>` separator,
  // which is what keeps a label that merely prefixes an ordinary name from
  // matching.
  for (const serverName of serverNames) {
    const prefix = `${serverName}${OPENCODE_LABEL_SEPARATOR}`;
    if (!toolName.startsWith(prefix)) {
      continue;
    }
    const remainder = toolName.slice(prefix.length);
    if (remainder.includes(MCP_SERVER_TOOL_NAME_SEPARATOR)) {
      return resolveRunToolTargetName(remainder);
    }
  }
  return stripLearnedDecoration(toolName, learnedPrefixes);
}

/**
 * The client-side decoration prefixes that sit in front of one of our branded
 * tool names in the caller's own declared tool list.
 *
 * Compat uses them to resolve a label no gateway name matches. A client
 * namespaces every tool from ONE server with the SAME prefix, so a prefix in
 * front of a branded name is most likely that client's decoration for our
 * gateway, and stripping it lets the third-party tools behind the gateway be
 * looked up and policied.
 *
 * Most likely, not provably: any server can put a branded name behind its own
 * prefix, claim that prefix, and have its other tools read as the gateway's
 * third-party tools. That is why only compat learns prefixes, and why
 * {@link stripLearnedDecoration} never hands back a branded name. Attested
 * mode uses this only to flag, in its warning, unattested declarations that
 * look like ours.
 */
function learnGatewayDecorationPrefixes(
  declaredToolNames: readonly string[],
): string[] {
  const prefixes = new Set<string>();
  for (const toolName of declaredToolNames) {
    const segments = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
    // Start at 1: a zero-length prefix is an undecorated name, which the strict
    // path already handles and which must not turn every name into a match.
    for (let i = 1; i < segments.length; i++) {
      const remainder = segments.slice(i).join(MCP_SERVER_TOOL_NAME_SEPARATOR);
      if (archestraMcpBranding.isToolName(remainder)) {
        prefixes.add(
          segments.slice(0, i).join(MCP_SERVER_TOOL_NAME_SEPARATOR) +
            MCP_SERVER_TOOL_NAME_SEPARATOR,
        );
        break;
      }
    }
    // OpenCode's `<label>_<advertised name>` join: the prefix ends at the
    // single underscore in front of one of our branded names.
    for (
      let i = toolName.indexOf(OPENCODE_LABEL_SEPARATOR);
      i > 0;
      i = toolName.indexOf(OPENCODE_LABEL_SEPARATOR, i + 1)
    ) {
      const remainder = toolName.slice(i + 1);
      if (
        !remainder.startsWith(OPENCODE_LABEL_SEPARATOR) &&
        archestraMcpBranding.isToolName(remainder)
      ) {
        prefixes.add(toolName.slice(0, i + 1));
        break;
      }
    }
  }
  // Longest first, so the most specific decoration wins when one prefix is a
  // prefix of another.
  return [...prefixes].sort((a, b) => b.length - a.length);
}

/**
 * Compat: strip a learned decoration prefix, refusing to produce a branded
 * built-in name.
 *
 * Built-ins bypass tool-invocation and trusted-data policies, so granting that
 * status on the strength of a learned prefix would let a hostile server opt its
 * own tools out of enforcement by naming them after ours. Everything else the
 * prefix reveals is a third-party tool name that gets looked up and policied.
 * The `run_tool` wrapper does not need this path: compat recognizes it behind
 * a decoration with the loose dispatch scan.
 */
function stripLearnedDecoration(
  toolName: string,
  learnedPrefixes: readonly string[],
): string {
  for (const prefix of learnedPrefixes) {
    if (!toolName.startsWith(prefix)) {
      continue;
    }
    const remainder = toolName.slice(prefix.length);
    if (remainder === "" || archestraMcpBranding.isToolName(remainder)) {
      return toolName;
    }
    return remainder;
  }
  return toolName;
}

/** Assembles the identity object; `spellingOf` is precomputed over the declarations. */
function identityOf(params: {
  mode: GatewayToolIdentity["mode"];
  canonicalize: ToolNameCanonicalizer;
  effective: ReadonlyMap<string, VerifiedToolDeclaration>;
  declarations: readonly DeclaredToolSpelling[];
  verified: readonly VerifiedToolDeclaration[];
  unverifiedMarkerCount: number;
}): GatewayToolIdentity {
  // Canonical name → the one declaration spelling it, or null once a second
  // declaration spells it too.
  const spellings = new Map<string, DeclaredToolSpelling | null>();
  for (const { name, namespace } of params.declarations) {
    const canonicalName = params.canonicalize(name, namespace);
    spellings.set(
      canonicalName,
      spellings.has(canonicalName)
        ? null
        : { name, ...(namespace ? { namespace } : {}) },
    );
  }
  return {
    mode: params.mode,
    canonicalize: params.canonicalize,
    looseRunToolDispatch: params.mode === "compat",
    attestationOf: (name, namespace) =>
      params.effective.get(declarationKey(name, namespace)),
    spellingOf: (canonicalName) => spellings.get(canonicalName) ?? undefined,
    verified: params.verified,
    unverifiedMarkerCount: params.unverifiedMarkerCount,
  };
}

/**
 * One entry per (namespace, name), preferring one that carries a marker: a
 * client declares each name once, so a repeat adds nothing but its marker.
 */
function dedupeDeclarations(
  declarations: readonly GatewayToolDeclaration[],
): GatewayToolDeclaration[] {
  const byKey = new Map<string, GatewayToolDeclaration>();
  for (const declaration of declarations) {
    const key = declarationKey(declaration.name, declaration.namespace);
    const kept = byKey.get(key);
    if (!kept || (!kept.marker && declaration.marker)) {
      byKey.set(key, declaration);
    }
  }
  return [...byKey.values()];
}

function declarationKey(name: string, namespace: string | undefined): string {
  return `${namespace ?? ""}\u0000${name}`;
}

/** A name as one string: namespaced names join as `<namespace>__<name>`. */
function spelledName(name: string, namespace?: string): string {
  return namespace
    ? `${namespace}${MCP_SERVER_TOOL_NAME_SEPARATOR}${name}`
    : name;
}

/**
 * True when an unattested spelling would read as one of the platform's
 * built-ins. Only a branded name does: the strict built-in checks need the
 * server prefix, so a bare short name such as `read_file` confers nothing and
 * keeps its own identity (a client's native tool may be named that way). Bare
 * short names are expanded only as run_tool targets, which a strict wrapper
 * governs. The single place that rule is applied.
 */
function isBuiltInLookalike(spelled: string): boolean {
  return archestraMcpBranding.isToolName(spelled);
}

/**
 * The third-party tool names an unattested spelling must not take, among
 * those this request spells: the names its verified declarations advertise,
 * and the names of tools an installed MCP server serves. Policies are looked
 * up by name, so an unattested `github__list_repos` (OpenCode's label
 * `github` on a tool advertised as `_list_repos`, or a bare name next to a
 * gateway that lists only its dispatch pair) would otherwise be ruled, and
 * its results trusted, as the real tool. Names the proxy only discovered keep
 * their spelling: no gateway serves them.
 */
async function gatewayServedToolNames(params: {
  verified: readonly VerifiedToolDeclaration[];
  unattested: readonly string[];
}): Promise<Set<string>> {
  const served = new Set(
    params.verified.map(({ advertisedName }) => advertisedName),
  );
  // A gateway tool's name is always `<server>__<tool>`.
  const candidates = params.unattested.filter(
    (spelled) =>
      !served.has(spelled) &&
      spelled.includes(MCP_SERVER_TOOL_NAME_SEPARATOR) &&
      !isBuiltInLookalike(spelled),
  );
  for (const name of await ToolModel.getCatalogToolNames([
    ...new Set(candidates),
  ])) {
    served.add(name);
  }
  return served;
}

/** How deep into the segments a client's gateway label may sit (0 or 1). */
const GATEWAY_LABEL_MAX_INDEX = 1;

/** OpenCode names an MCP tool `<label>_<tool>`. */
const OPENCODE_LABEL_SEPARATOR = "_";

async function getGatewayServerNames(
  organizationId: string,
): Promise<Set<string>> {
  const cached = gatewayServerNamesCache.get(organizationId);
  if (cached) {
    return cached;
  }
  const gatewayNames =
    await AgentModel.findGatewayNamesByOrganizationId(organizationId);
  const serverNames = new Set(
    gatewayNames.map(toMcpClientServerName).filter(Boolean),
  );
  gatewayServerNamesCache.set(organizationId, serverNames);
  return serverNames;
}

/**
 * Per-organization cache of gateway client server names. Gateway renames are
 * rare; a short TTL keeps proxy requests from querying agents on every call.
 */
const gatewayServerNamesCache = new LRUCacheManager<Set<string>>({
  maxSize: 500,
  defaultTtl: 60_000,
});
