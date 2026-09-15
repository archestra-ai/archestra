import { createHash } from "node:crypto";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
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

const INITIAL_POLICY = `# Organization policy. Unlisted tools are denied.
# Saved changes apply to new conversations.
[policy]
version = 2

# Policy administration requires a trusted conversation.
[[policy.tool]]
name = "archestra__get_guardrails_policy"
requires = { trust = "trusted" }
delta = {}

[[policy.tool]]
name = "archestra__validate_guardrails_policy"
requires = { trust = "trusted" }
delta = {}

[[policy.tool]]
name = "archestra__update_guardrails_policy"
requires = { trust = "trusted" }
delta = {}

[[policy.tool]]
name = "archestra__search_tools"
delta = {}
`;
