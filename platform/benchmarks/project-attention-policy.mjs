import assert from "node:assert/strict";

export async function withProjectAttentionPolicy({
  api,
  target,
  authorityUrl,
  rules = [{ target, attention: "benchmark-project-signoff" }],
  protocol = "project",
  work,
}) {
  const original = await api("GET", "/api/guardrails-policy");
  const deployment = await api("GET", "/api/guardrails-deployment");
  assert.ok(
    !deployment.active && !deployment.enabled,
    "policy_setup_requires_idle_off",
  );
  assert.ok(
    typeof original.content === "string" && Number.isInteger(original.revision),
  );
  const content = projectAttentionPolicyContent({
    original: original.content,
    authorityUrl,
    rules,
    protocol,
  });
  assert.equal(
    (await api("POST", "/api/guardrails-policy/validate", { content })).valid,
    true,
    "project_attention_policy_invalid",
  );
  const installed = await api("PUT", "/api/guardrails-policy", {
    content,
    expectedRevision: original.revision,
  });
  assert.ok(
    Number.isInteger(installed.revision) &&
      typeof installed.contentHash === "string",
  );
  const audit = {
    originalHash: original.contentHash,
    originalRevision: original.revision,
    installedHash: installed.contentHash,
    installedRevision: installed.revision,
    restored: false,
  };
  try {
    const result = await work();
    return { result, policy: audit };
  } finally {
    const active = await api("GET", "/api/guardrails-policy");
    assert.ok(
      active.revision === installed.revision &&
        active.contentHash === installed.contentHash,
      "policy_changed_during_project_case",
    );
    const restored = await api("PUT", "/api/guardrails-policy", {
      content: original.content,
      expectedRevision: installed.revision,
    });
    const verified = await api("GET", "/api/guardrails-policy");
    audit.restored =
      restored.contentHash === original.contentHash &&
      verified.contentHash === original.contentHash &&
      verified.revision === restored.revision;
    audit.restoredRevision = restored.revision;
    assert.ok(audit.restored, "project_policy_restoration_failed");
  }
}

export function projectAttentionPolicyContent({
  original,
  authorityUrl,
  rules,
  protocol = "project",
}) {
  assert.equal(protocol, "project");
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.match(
      rule.target,
      /^bench-[a-z0-9-]+__project_(?:publish|(?:read|edit)\(path:src\/[A-Za-z]+\.mjs\))$/,
    );
    assert.match(rule.attention, /^benchmark-[a-z0-9_-]+$/);
  }
  assert.equal(new Set(rules.map((rule) => rule.target)).size, rules.length);
  const authority = new URL(authorityUrl);
  assert.ok(
    authority.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(authority.hostname) &&
      authority.pathname === "/authority" &&
      !authority.username &&
      !authority.password &&
      !authority.search &&
      !authority.hash,
    "owned_loopback_authority_required",
  );
  return `${original}\n${rules
    .map(
      (rule) => `
[[policy.tool]]
name = ${JSON.stringify(rule.target)}
delta = {}
requires = { attention = [${JSON.stringify(rule.attention)}] }
`,
    )
    .join("\n")}

[[policy.authority]]
name = "benchmark-project-authority"
permits = { attention = ${JSON.stringify(rules.map((rule) => rule.attention))} }

[externals.authorities.benchmark-project-authority]
url = ${JSON.stringify(authority.href)}
`;
}
