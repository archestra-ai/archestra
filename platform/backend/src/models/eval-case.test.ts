import db, { schema } from "@/database";
import { expect, test } from "@/test";
import EvalCaseModel, { MAX_CASES_PER_SUITE } from "./eval-case";
import EvalSuiteModel from "./eval-suite";

const SAMPLE_ASSERTIONS = [
  {
    type: "exact_match" as const,
    expected: "42",
    caseSensitive: false,
    trim: true,
  },
];

async function makeSuite(organizationId: string) {
  return await EvalSuiteModel.create({
    organizationId,
    name: `Suite ${crypto.randomUUID().slice(0, 8)}`,
  });
}

test("create appends cases with increasing positions", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const suite = await makeSuite(org.id);

  const first = await EvalCaseModel.create({
    organizationId: org.id,
    insert: {
      suiteId: suite.id,
      name: "first",
      input: "1",
      assertions: SAMPLE_ASSERTIONS,
    },
  });
  const second = await EvalCaseModel.create({
    organizationId: org.id,
    insert: {
      suiteId: suite.id,
      name: "second",
      input: "2",
      assertions: SAMPLE_ASSERTIONS,
    },
  });

  expect(first.position).toBe(1);
  expect(second.position).toBe(2);

  const cases = await EvalCaseModel.listBySuite(suite.id);
  expect(cases.map((c) => c.name)).toEqual(["first", "second"]);
});

test("create rejects foreign-org and soft-deleted suites", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const suite = await makeSuite(org.id);

  await expect(
    EvalCaseModel.create({
      organizationId: otherOrg.id,
      insert: {
        suiteId: suite.id,
        name: "x",
        input: "x",
        assertions: SAMPLE_ASSERTIONS,
      },
    }),
  ).rejects.toThrow("Eval suite not found");

  await EvalSuiteModel.softDelete(suite.id, org.id);
  await expect(
    EvalCaseModel.create({
      organizationId: org.id,
      insert: {
        suiteId: suite.id,
        name: "x",
        input: "x",
        assertions: SAMPLE_ASSERTIONS,
      },
    }),
  ).rejects.toThrow("Eval suite not found");
});

test("create enforces the per-suite case cap", async ({ makeOrganization }) => {
  const org = await makeOrganization();
  const suite = await makeSuite(org.id);

  // Bulk-seed the suite to the cap directly; the model path is exercised by
  // the final create.
  await db.insert(schema.evalCasesTable).values(
    Array.from({ length: MAX_CASES_PER_SUITE }, (_, i) => ({
      suiteId: suite.id,
      name: `seed ${i}`,
      input: "x",
      assertions: SAMPLE_ASSERTIONS,
      position: i + 1,
    })),
  );

  await expect(
    EvalCaseModel.create({
      organizationId: org.id,
      insert: {
        suiteId: suite.id,
        name: "one too many",
        input: "x",
        assertions: SAMPLE_ASSERTIONS,
      },
    }),
  ).rejects.toThrow(`limited to ${MAX_CASES_PER_SUITE} cases`);
});

test("findById, update and delete are org-scoped", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const suite = await makeSuite(org.id);
  const evalCase = await EvalCaseModel.create({
    organizationId: org.id,
    insert: {
      suiteId: suite.id,
      name: "target",
      input: "input",
      assertions: SAMPLE_ASSERTIONS,
    },
  });

  expect(await EvalCaseModel.findById(evalCase.id, otherOrg.id)).toBeNull();
  expect(
    await EvalCaseModel.update({
      id: evalCase.id,
      organizationId: otherOrg.id,
      updates: { name: "hijacked" },
    }),
  ).toBeNull();
  expect(
    await EvalCaseModel.delete({
      id: evalCase.id,
      organizationId: otherOrg.id,
    }),
  ).toBe(false);

  const newAssertions = [
    { type: "regex" as const, pattern: "\\d+" },
    {
      type: "llm_judge" as const,
      criteria: "the answer is numeric",
    },
  ];
  const updated = await EvalCaseModel.update({
    id: evalCase.id,
    organizationId: org.id,
    updates: { name: "renamed", input: "new input", assertions: newAssertions },
  });
  expect(updated?.name).toBe("renamed");
  expect(updated?.assertions).toEqual(newAssertions);

  expect(
    await EvalCaseModel.delete({ id: evalCase.id, organizationId: org.id }),
  ).toBe(true);
  expect(await EvalCaseModel.findById(evalCase.id, org.id)).toBeNull();
});
