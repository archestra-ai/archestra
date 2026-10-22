// @vitest-environment node
import { expect, test } from "vitest";
import { labelCostsCsv } from "./label-costs-csv";

test("exports exact accounting values and distinguishes an absent label from a literal Unassigned value", () => {
  const row = {
    requests: 2,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    billedCost: 0.123456,
    subscriptionCost: 2.5,
  };
  const csv = labelCostsCsv({
    key: "cost_center",
    groups: [
      { ...row, value: null },
      { ...row, value: "Unassigned" },
      { ...row, value: 'Finance,"West"\nDesk' },
      { ...row, value: "=HYPERLINK(test)" },
    ],
  });
  expect(csv).toContain(
    '"cost_center","","false","2","100","20","10","0.123456","2.5"',
  );
  expect(csv).toContain('"cost_center","Unassigned","true"');
  expect(csv).toContain('"Finance,""West""\nDesk"');
  expect(csv).toContain('"\'=HYPERLINK(test)"');
});
