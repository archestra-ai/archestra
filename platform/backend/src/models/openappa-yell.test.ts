import client from "prom-client";
import { initializeOpenappaMetrics } from "@/observability/metrics/openappa";
import { expect, test } from "@/test";
import OpenAppaYellModel from "./openappa-yell";

test("a retried agent yell is one row and counts once in openappa_yells_total", async ({
  makeOrganization,
}) => {
  initializeOpenappaMetrics();
  const organizationId = (await makeOrganization()).id;
  const yell = {
    organizationId,
    callerId: "user:u1",
    sessionId: "user:u1|s1",
    toolCallId: "call-1",
    message: "the remedy plan makes no sense",
    withTrajectory: false,
    superyell: true,
  };
  const before = await agentSuperyells();
  const first = await OpenAppaYellModel.record(yell);
  const retried = await OpenAppaYellModel.record(yell);
  expect(retried.id).toBe(first.id);
  expect((await agentSuperyells()) - before).toBe(1);
});

async function agentSuperyells(): Promise<number> {
  const values =
    (await client.register.getSingleMetric("openappa_yells_total")?.get())
      ?.values ?? [];
  return (
    values.find(
      (v) => v.labels.kind === "agent" && v.labels.superyell === "true",
    )?.value ?? 0
  );
}
