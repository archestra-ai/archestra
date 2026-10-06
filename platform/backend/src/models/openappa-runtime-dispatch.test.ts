import db, { schema } from "@/database";
import { expect, test } from "@/test";
import OpenAppaSpawnCorrelationModel from "./openappa-spawn-correlation";

test("a released runtime call has one durable execution claimant across concurrent callers", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const claim = {
    organizationId: org.id,
    callerId: "user:qa-owner",
    sessionId: "qa-source-session",
    toolCallId: "qa-runtime-call",
    spawn: true,
  };
  await db.insert(schema.openappaOperationsTable).values({
    organizationId: org.id,
    callerId: claim.callerId,
    sessionId: claim.sessionId,
    operationId: `call:${claim.toolCallId}`,
    root: "qa-root",
    status: "complete",
    input: { semantic: { event: "tool_call", spawn: true } },
    decision: { decision: "allow_call" },
  });
  expect(
    await OpenAppaSpawnCorrelationModel.claimRuntimeDispatch({
      ...claim,
      callerId: "user:another-owner",
    }),
  ).toBe(false);
  expect(
    await OpenAppaSpawnCorrelationModel.claimRuntimeDispatch({
      ...claim,
      spawn: false,
    }),
  ).toBe(false);
  const claimed = await Promise.all(
    Array.from({ length: 8 }, () =>
      OpenAppaSpawnCorrelationModel.claimRuntimeDispatch(claim),
    ),
  );
  expect(claimed.filter(Boolean)).toHaveLength(1);
  expect(await OpenAppaSpawnCorrelationModel.claimRuntimeDispatch(claim)).toBe(
    false,
  );
  const rows = await db.select().from(schema.openappaOperationsTable);
  expect(
    rows.filter(
      (row) => row.operationId === `runtime-dispatch:${claim.toolCallId}`,
    ),
  ).toHaveLength(1);
  const gatewayClaims = await Promise.all(
    Array.from({ length: 8 }, () =>
      OpenAppaSpawnCorrelationModel.claimRuntimeDispatch({
        ...claim,
        dispatch: "gateway",
      }),
    ),
  );
  expect(gatewayClaims.filter(Boolean)).toHaveLength(1);
  expect(
    await OpenAppaSpawnCorrelationModel.claimRuntimeDispatch({
      ...claim,
      dispatch: "gateway",
    }),
  ).toBe(false);
  expect(
    (await db.select().from(schema.openappaOperationsTable)).filter(
      (row) => row.operationId === `gateway-dispatch:${claim.toolCallId}`,
    ),
  ).toHaveLength(1);
});

test("a missing, pending, or denied authorization cannot reserve a runtime dispatch", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const claim = {
    organizationId: org.id,
    callerId: "user:qa-owner",
    sessionId: "qa-source-session",
    toolCallId: "missing",
    spawn: false,
  };
  expect(await OpenAppaSpawnCorrelationModel.claimRuntimeDispatch(claim)).toBe(
    false,
  );
  for (const status of ["pending", "denied"] as const) {
    await db.insert(schema.openappaOperationsTable).values({
      organizationId: org.id,
      callerId: claim.callerId,
      sessionId: claim.sessionId,
      operationId: `call:${status}`,
      root: "qa-root",
      status: status === "pending" ? "pending" : "complete",
      input: { semantic: { spawn: false } },
      decision: status === "pending" ? null : { decision: "block" },
    });
    expect(
      await OpenAppaSpawnCorrelationModel.claimRuntimeDispatch({
        ...claim,
        toolCallId: status,
      }),
    ).toBe(false);
  }
  expect(
    (await db.select().from(schema.openappaOperationsTable)).some((row) =>
      row.operationId.startsWith("runtime-dispatch:"),
    ),
  ).toBe(false);
});
