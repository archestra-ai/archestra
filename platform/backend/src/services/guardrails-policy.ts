import { createHash } from "node:crypto";
import { userHasPermission } from "@/auth";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { addedGrants, openappaDeclarations } from "@/openappa/declarations";
import { GUARDRAILS_NOOP_ANNOTATOR_PATH } from "@/routes/route-paths";
import { ApiError } from "@/types";
import type { GuardrailsPolicy } from "@/types/guardrails-policy";

/** The 409 a lost revision race answers with; a retrying writer waits for this one. */
export const GUARDRAILS_REVISION_CONFLICT = "guardrails_policy_revision_stale";

export const guardrailsPolicyService = {
  async get(organizationId: string): Promise<GuardrailsPolicy> {
    requireEnabled();
    return (
      (await GuardrailsPolicyModel.findLatest(organizationId)) ?? {
        organizationId,
        revision: 0,
        content: INITIAL_POLICY,
        contentHash: hash(INITIAL_POLICY),
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
   */
  async validate(
    content: string,
    params: { organizationId: string; previous?: string },
  ) {
    requireEnabled();
    const { organizationId } = params;
    const resolution = await openappaDeclarations.resolve({
      organizationId,
      content,
    });
    const errors = [...resolution.errors];
    const previous =
      params.previous ?? (await this.get(organizationId)).content;
    const kept = new Set(
      (
        await openappaDeclarations.resolve({
          organizationId,
          content: previous,
        })
      ).entries.map((entry) => entry.entry),
    );
    for (const entry of resolution.entries)
      if (!entry.battery && !kept.has(entry.entry))
        errors.push(
          `include: no battery answers ${JSON.stringify(entry.entry)}`,
        );
    if (errors.length === 0) {
      const composed = await openappaDeclarations.composeForCheck({
        root: content,
        resolution,
      });
      if ((composed.content ?? null) === null) errors.push(...composed.errors);
    }
    return { valid: errors.length === 0, errors };
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
    const granted = addedGrants(
      await openappaDeclarations.grantsOf({
        organizationId,
        content: latest.content,
      }),
      await openappaDeclarations.grantsOf({ organizationId, content }),
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

const INITIAL_POLICY = `[policy]
version = 2

[[policy.annotator]]
name = "noop"

# Tools without a specific rule have no additional restrictions.
[[policy.tool]]
name = "*"
annotator = "noop"

[externals.annotators.noop]
url = "http://127.0.0.1:${config.api.port}${GUARDRAILS_NOOP_ANNOTATOR_PATH}"
`;
