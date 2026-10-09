import { createHash } from "node:crypto";
import {
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { ARCHESTRA_BATTERY } from "@/openappa/archestra-audience";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  addedGrants,
  bundledEntry,
  openappaDeclarations,
  type PolicyResolution,
} from "@/openappa/declarations";
import { GUARDRAILS_NOOP_ANNOTATOR_PATH } from "@/routes/route-paths";
import { ApiError } from "@/types";
import type { GuardrailsPolicy } from "@/types/guardrails-policy";
import type { PolicyTestFile } from "@/types/openappa-policy-tests";

/**
 * A document and the revision it would replace, resolved together with the
 * stored credential bindings applied: resolving one says nothing about the
 * other, and every write compares the two as the host would compose them.
 */
async function resolveBoth(params: {
  organizationId: string;
  content: string;
  previous: string;
}): Promise<{ submitted: PolicyResolution; previous: PolicyResolution }> {
  const { organizationId } = params;
  const [submitted, previous] = await Promise.all([
    openappaDeclarations.resolveWithBindings({
      organizationId,
      content: params.content,
    }),
    openappaDeclarations.resolveWithBindings({
      organizationId,
      content: params.previous,
    }),
  ]);
  return { submitted: submitted.resolution, previous: previous.resolution };
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

/**
 * What this deployment's recompose would make of a document that composes on
 * its own: a battery the deployment holds back composes as empty, and the root
 * may name what it declares. A refusal the revision being replaced already
 * meets is a warning, so a write that leaves it as it was is never blocked by
 * it; one the document introduces is an error. Either way the held-back
 * batteries are named with it, since they are what the refusal is fixed by.
 * A held-back battery the document composes without is no refusal; its status
 * is the effective policy's to report.
 */
async function deploymentRefusal(params: {
  organizationId: string;
  content: string;
  previous: string;
}): Promise<{ errors: string[]; warnings: string[] }> {
  const { organizationId, content, previous } = params;
  const submitted = await openappaBatteriesService.composeInDeployment({
    organizationId,
    content,
  });
  if (submitted.refusal.length === 0) return { errors: [], warnings: [] };
  const kept = new Set(
    previous === content
      ? submitted.refusal
      : (
          await openappaBatteriesService.composeInDeployment({
            organizationId,
            content: previous,
          })
        ).refusal,
  );
  const introduced = submitted.refusal.filter((error) => !kept.has(error));
  const inDeployment = (line: string) => `in this deployment: ${line}`;
  const keptNote =
    " (the current revision is refused the same way; the runtime keeps enforcing the last composition that opened)";
  if (introduced.length > 0)
    return {
      errors: [...introduced, ...submitted.heldBack].map(inDeployment),
      warnings: [],
    };
  return {
    errors: [],
    warnings: [...submitted.refusal, ...submitted.heldBack].map(
      (line) => inDeployment(line) + keptNote,
    ),
  };
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

  /** The no-op annotator endpoint and the answer it serves, for offline replay. */
  noopAnnotator() {
    return { url: noopAnnotatorUrl(), response: this.annotate() };
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
    const previous =
      params.previous ?? (await this.get(organizationId)).content;
    const resolved =
      params.resolved ??
      (await resolveBoth({ organizationId, content, previous }));
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
      else {
        const deployed = await deploymentRefusal({
          organizationId,
          content,
          previous,
        });
        errors.push(...deployed.errors);
        warnings.push(...deployed.warnings);
      }
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
    validation?: { expectedVersion: string; files?: PolicyTestFile[] };
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
      validation: params.validation,
    });
    if (!saved)
      throw new ApiError(
        409,
        "This policy changed since you opened it. Reload the latest revision before saving.",
        GUARDRAILS_REVISION_CONFLICT,
      );
    if (latest.revision === 0 || latest.contentHash !== saved.contentHash) {
      try {
        await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
          organizationId,
          saved.contentHash,
        );
      } catch {
        logger.warn(
          { organizationId },
          "Could not queue informational validation after a policy change",
        );
      }
    }
    return saved;
  },
};

function requireEnabled() {
  if (!enterpriseTier.isOpenappaActive())
    throw new ApiError(404, "Guardrails v2 is disabled");
}
function noopAnnotatorUrl() {
  return `http://127.0.0.1:${config.api.port}${GUARDRAILS_NOOP_ANNOTATOR_PATH}`;
}
function hash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * The text an organization that never saved a revision is read as. It installs
 * the bundled `archestra` battery over the built-in tools, under the name they
 * carry in this deployment, reads the organization's members as `internal`, and
 * has the organization's default model label each sandbox command.
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

# A subagent's return that matches the bounded JSON schema its parent declared
# at the spawn crosses at the parent's trust. Built into the runtime.
[[policy.sanitizer]]
name = "attest-schema"
on = ["tool_output"]

[policy.sanitizer.permits]
trust = { from = "suspicious", to = "trusted" }

[[policy.annotator]]
name = "noop"

# Labels each sandbox command (run_command) with the organization's
# default model, through the LLM proxy.
[[policy.annotator]]
name = "archestra.run-command"
builtin = "archestra"
hint = "run_command runs a shell command in this conversation's sandbox, a scratch workspace. A command that only lists, reads or changes ordinary files in the sandbox, with no network access, keeps the neutral annotation unless a file it reads visibly holds credentials or secrets."
ranks = ["suspicious", "trusted"]
marks = []
effects = []

[[policy.tool]]
name = "${archestraMcpBranding.getToolName(TOOL_RUN_COMMAND_SHORT_NAME)}"
annotator = "archestra.run-command"

# Questions carry no data: they keep an empty label even if the catch-all
# below is made stricter. search_tools gets the same from the archestra battery.
[[policy.tool]]
name = "${archestraMcpBranding.getToolName(TOOL_ASK_USER_SHORT_NAME)}"
delta = {}

# Tools without a specific rule have no additional restrictions.
[[policy.tool]]
name = "*"
annotator = "noop"

# Review one exact call that explicitly requires human approval.
[[policy.authority]]
name = "hitl"
hint = "Ask the person running this session to approve this exact call."

[policy.authority.permits]
attention = ["human-approval"]

[externals.authorities.hitl]
builtin = "hitl"

[externals.annotators.noop]
url = "${noopAnnotatorUrl()}"
`;
}
