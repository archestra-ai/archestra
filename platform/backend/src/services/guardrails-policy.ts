import { createHash } from "node:crypto";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { userHasPermission } from "@/auth";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import {
  addedGrants,
  bundledEntry,
  openappaDeclarations,
  type PolicyResolution,
} from "@/openappa/declarations";
import { GUARDRAILS_NOOP_ANNOTATOR_PATH } from "@/routes/route-paths";
import { ApiError } from "@/types";
import type { GuardrailsPolicy } from "@/types/guardrails-policy";

/**
 * A document and the revision it would replace, resolved together: resolving
 * one says nothing about the other, and every write compares the two.
 */
async function resolveBoth(params: {
  organizationId: string;
  content: string;
  previous: string;
}): Promise<{ submitted: PolicyResolution; previous: PolicyResolution }> {
  const { organizationId } = params;
  const [submitted, previous] = await Promise.all([
    openappaDeclarations.resolve({ organizationId, content: params.content }),
    openappaDeclarations.resolve({ organizationId, content: params.previous }),
  ]);
  return { submitted, previous };
}

/**
 * Two entries answering one battery name: the runtime refuses to compose such a
 * document, and the installs derived from it would collide on one row. The
 * error names both entries so the author can see which line to drop.
 */
function duplicateEntryErrors(resolution: PolicyResolution): string[] {
  const byName = new Map<string, typeof resolution.entries>();
  for (const entry of resolution.entries)
    if (entry.battery)
      byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  return [...byName]
    .filter(([, entries]) => entries.length > 1)
    .map(
      ([name, entries]) =>
        `include: ${JSON.stringify(name)} is included ${entries.length} times: ${entries
          .map((entry) => `${JSON.stringify(entry.entry)} (line ${entry.line})`)
          .join(", ")}`,
    );
}

/** The 409 a lost revision race answers with; a retrying writer waits for this one. */
export const GUARDRAILS_REVISION_CONFLICT = "guardrails_policy_revision_stale";

export const guardrailsPolicyService = {
  async get(organizationId: string): Promise<GuardrailsPolicy> {
    requireEnabled();
    const initial = initialPolicy();
    return (
      (await GuardrailsPolicyModel.findLatest(organizationId)) ?? {
        organizationId,
        revision: 0,
        content: initial,
        contentHash: hash(initial),
        updatedAt: null,
        updatedBy: null,
      }
    );
  },

  annotate() {
    requireEnabled();
    return {
      version: 1 as const,
      answer: {
        delta: {},
        requires: { history: [], attention: [] },
        emits: [],
      },
    };
  },

  /**
   * Check a document by composing it, the way a recompose composes it: the
   * batteries its `include` list names are resolved and composed under it, and the
   * result is opened in a memory runtime. Validation never installs a policy,
   * executes a tool or contacts a declared external service.
   *
   * An include entry that resolves to nothing is refused only when it is new or
   * changed against `previous` — the revision this document would replace. An
   * unchanged entry that stopped resolving composes as an empty battery, so one
   * stale entry never takes a whole policy down. `previous` defaults to the
   * organization's latest revision, which is what every save is measured against.
   *
   * Such an entry is a warning, not an error: the document is valid and the
   * battery it names governs nothing. A caller that reports "valid" and stops
   * there hides a battery that stopped working, so every path that reports a
   * validation reports its warnings too.
   */
  async validate(
    content: string,
    params: {
      organizationId: string;
      previous?: string;
      /** Both documents already resolved, when the caller resolved them itself. */
      resolved?: { submitted: PolicyResolution; previous: PolicyResolution };
    },
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    requireEnabled();
    const { organizationId } = params;
    const resolved =
      params.resolved ??
      (await resolveBoth({
        organizationId,
        content,
        previous: params.previous ?? (await this.get(organizationId)).content,
      }));
    const resolution = resolved.submitted;
    const errors = [...resolution.errors];
    const kept = new Set(resolved.previous.entries.map((entry) => entry.entry));
    const warnings: string[] = [];
    for (const entry of resolution.entries)
      if (!entry.battery)
        (kept.has(entry.entry) ? warnings : errors).push(
          kept.has(entry.entry)
            ? `include: ${JSON.stringify(entry.entry)} resolves to no battery and governs nothing`
            : `include: no battery answers ${JSON.stringify(entry.entry)}`,
        );
    errors.push(...duplicateEntryErrors(resolution));
    if (errors.length === 0) {
      const composed = await openappaDeclarations.composeForCheck({
        root: content,
        resolution,
      });
      if ((composed.content ?? null) === null) errors.push(...composed.errors);
    }
    return { valid: errors.length === 0, errors, warnings };
  },

  /**
   * Save a new revision of the organization's policy.
   *
   * Every user-driven write of the text passes here, so this is where a credential
   * grant — an organization credential's value reaching a battery's helper sandbox
   * — is authorized. A grant the submitted text adds, or whose key it changes
   * against the latest revision, takes `credential:update`; removing one takes
   * nothing beyond the route's own permission. The diff runs against the latest
   * revision, so a stale `expectedRevision` still ends in the save's own conflict.
   */
  async update(params: {
    organizationId: string;
    userId: string;
    content: string;
    expectedRevision: number;
  }) {
    requireEnabled();
    const { organizationId, userId, content } = params;
    if ((await OpenAppaGithubSyncModel.find(organizationId))?.interval)
      throw new ApiError(
        409,
        "Stop GitHub syncing before editing this policy.",
      );
    const latest = await this.get(organizationId);
    const resolved = await resolveBoth({
      organizationId,
      content,
      previous: latest.content,
    });
    const granted = addedGrants(
      openappaDeclarations.grants(resolved.previous),
      openappaDeclarations.grants(resolved.submitted),
    );
    if (
      granted.length > 0 &&
      !(await userHasPermission(userId, organizationId, "credential", "update"))
    )
      throw new ApiError(
        403,
        `Credential update permission is required: this policy hands ${granted
          .map((grant) => `${grant.variable} to ${grant.battery}`)
          .join(", ")}`,
      );
    const validation = await this.validate(content, {
      organizationId,
      previous: latest.content,
      resolved,
    });
    if (!validation.valid)
      throw new ApiError(400, validation.errors.join("\n"));
    const saved = await GuardrailsPolicyModel.save({
      organizationId,
      updatedBy: userId,
      content,
      contentHash: hash(content),
      expectedRevision: params.expectedRevision,
    });
    if (!saved)
      throw new ApiError(
        409,
        "This policy changed since you opened it. Reload the latest revision before saving.",
        GUARDRAILS_REVISION_CONFLICT,
      );
    return saved;
  },
};

function requireEnabled() {
  if (!config.openappa.enabled)
    throw new ApiError(404, "Guardrails v2 is disabled");
}
function hash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The text an organization that never saved a revision is read as. It installs
 * the bundled `archestra` battery over the built-in tools, under the name they
 * carry in this deployment, and reads the organization's members as `internal`.
 */
export function initialPolicy(): string {
  return `include = ["${bundledEntry(ARCHESTRA_BATTERY)}"]

[server_aliases]
${ARCHESTRA_BATTERY} = ["${archestraMcpBranding.serverName}"]

[policy]
version = 2

[policy.audience]
internal = ["${ARCHESTRA_BATTERY}:members"]

[policy.deployment]
context_control = true

[[policy.annotator]]
name = "noop"

# Tools without a specific rule have no additional restrictions.
[[policy.tool]]
name = "*"
annotator = "noop"

[externals.annotators.noop]
url = "http://127.0.0.1:${config.api.port}${GUARDRAILS_NOOP_ANNOTATOR_PATH}"
`;
}

const ARCHESTRA_BATTERY = "archestra";
