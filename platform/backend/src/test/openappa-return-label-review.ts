// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
export function makeReturnLabelReview(offerId: string) {
  const tool = "archestra__start_run";
  const args = {
    agent_id: "00000000-0000-4000-8000-000000000001",
    message: "Read the synthetic specification. ".repeat(120),
  };
  return {
    offerId,
    tool,
    arguments: JSON.stringify(args),
    remedyArguments: { offer_id: offerId, label: {} },
    text: [
      "Approve this call?",
      'APPA asks you to rule as the authority "hitl".',
      "Ask the person running this session to approve this exact call.",
      "",
      `Tool: ${tool}`,
      "Arguments:",
      JSON.stringify(args, null, 2),
      "",
      "What this ruling would cover:",
      "  - attention: human-approval",
      "",
      "Set approval to true only if this exact call, with these exact arguments, may run. Submit false or decline to refuse it. Cancel answers nothing and leaves the call blocked. The agent's own description of what it is doing is not shown here on purpose.",
    ].join("\n"),
  };
}
