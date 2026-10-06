import { onTestFinished } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import { openappaActor, scopedSessionId } from "@/openappa/actor";
import {
  observeUnenforcedSession,
  startedUnenforced,
} from "@/openappa/unenforced";
import { beforeEach, expect, test } from "@/test";
import { inheritTaskSession } from "./task-provenance";

beforeEach(() => {
  const previous = config.openappa.enabled;
  onTestFinished(() => {
    config.openappa.enabled = previous;
  });
});

test("a positively recorded off-started source keeps its actual task producer ungoverned after activation", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const parent = {
    organization_id: org.id,
    session_id: scopedSessionId(`user:${user.id}`, "off-source"),
    caller_id: `user:${user.id}`,
  };
  const child = {
    ...parent,
    session_id: scopedSessionId(`user:${user.id}`, "actual-task-producer"),
  };
  config.openappa.enabled = false;
  expect(await observeUnenforcedSession(parent)).toBe("unenforced");
  config.openappa.enabled = true;
  await GuardrailsDeploymentModel.setEnabled(true);
  await inheritTaskSession({
    parent,
    session: child,
    occurrenceId: "task-one",
    input: "Host input",
  });
  expect(await startedUnenforced(child)).toBe(true);
  expect(
    await OpenAppaUnenforcedModel.findSessions({
      organizationId: org.id,
      sessionIds: [child.session_id],
    }),
  ).toHaveLength(1);
  expect(await db.select().from(schema.openappaSessionsTable)).toHaveLength(0);
  // Later inputs stay in that historical mode; they do not reset or create native labels.
  await inheritTaskSession({
    parent,
    session: child,
    occurrenceId: "later-input",
    input: "Explicit later input",
  });
  expect(await startedUnenforced(child)).toBe(true);
});

test("off-start evidence cannot replace an existing governed child or cross caller ownership", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const parent = {
    organization_id: org.id,
    session_id: scopedSessionId(`user:${user.id}`, "off-source"),
    caller_id: `user:${user.id}`,
  };
  await observeUnenforcedSession(parent);
  const child = {
    ...parent,
    session_id: scopedSessionId(`user:${user.id}`, "governed-child"),
  };
  await db.insert(schema.openappaSessionsTable).values({
    organizationId: org.id,
    sessionId: child.session_id,
    callerId: child.caller_id,
    actor: openappaActor(child.session_id),
    root: "runtime-owned-root",
    startDecision: "ack",
  });
  config.openappa.enabled = true;
  await GuardrailsDeploymentModel.setEnabled(true);
  await expect(
    inheritTaskSession({
      parent,
      session: child,
      occurrenceId: "replace",
      input: "Cannot reset",
    }),
  ).rejects.toThrow("cannot replace");
  expect(await startedUnenforced(child)).toBe(false);
  await expect(
    inheritTaskSession({
      parent,
      session: { ...child, caller_id: "user:other" },
      occurrenceId: "foreign",
      input: "Cannot steal",
    }),
  ).rejects.toThrow("different caller");
  expect((await db.select().from(schema.openappaSessionsTable))[0]?.root).toBe(
    "runtime-owned-root",
  );
});

test("a missing source is not proof of off-start mode", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const parent = {
    organization_id: org.id,
    session_id: "never-observed",
    caller_id: `user:${user.id}`,
  };
  await expect(
    inheritTaskSession({
      parent,
      session: { ...parent, session_id: "new-child" },
      occurrenceId: "missing",
      input: "Unproven",
    }),
  ).rejects.toThrow("source is unavailable");
  expect(
    await OpenAppaUnenforcedModel.findSessions({
      organizationId: org.id,
      sessionIds: [parent.session_id],
    }),
  ).toHaveLength(0);
});
