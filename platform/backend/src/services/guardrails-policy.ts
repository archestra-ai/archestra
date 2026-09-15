import { createHash } from "node:crypto";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { GUARDRAILS_NOOP_ANNOTATOR_PATH } from "@/routes/route-paths";
import { ApiError } from "@/types";
import type { GuardrailsPolicy } from "@/types/guardrails-policy";

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

  async validate(content: string) {
    requireEnabled();
    const native = await import("@archestra/openappa-rs");
    // Validation compiles against an isolated in-memory store; it never installs
    // a policy, executes a tool, or contacts a declared external service.
    const errors = await native.validateOpenappaPolicy(content);
    return { valid: errors.length === 0, errors };
  },

  async update(params: {
    organizationId: string;
    userId: string;
    content: string;
    expectedRevision: number;
  }) {
    requireEnabled();
    const validation = await this.validate(params.content);
    if (!validation.valid)
      throw new ApiError(400, validation.errors.join("\n"));
    const saved = await GuardrailsPolicyModel.save({
      organizationId: params.organizationId,
      updatedBy: params.userId,
      content: params.content,
      contentHash: hash(params.content),
      expectedRevision: params.expectedRevision,
    });
    if (!saved)
      throw new ApiError(
        409,
        "This policy changed since you opened it. Reload the latest revision before saving.",
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
