import { eq } from "drizzle-orm";
import { A2AProtocolTaskState } from "@/agents/a2a/a2a-protocol";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import A2AContextModel from "./a2a-context";
import A2ATaskModel from "./a2a-task";

async function createContext() {
  return await A2AContextModel.create({
    actorKind: "user",
    actorId: crypto.randomUUID(),
  });
}

describe("A2ATaskModel", () => {
  describe("create", () => {
    test("updates context updatedAt when a task is created", async () => {
      const context = await createContext();
      const originalUpdatedAt = context.updatedAt;

      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      expect(task.id).toBeDefined();
      expect(task.contextId).toBe(context.id);
      expect(task.state).toBe(A2AProtocolTaskState.Submitted);

      const [updatedContext] = await db
        .select()
        .from(schema.a2aContextsTable)
        .where(eq(schema.a2aContextsTable.id, context.id));

      expect(updatedContext.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime(),
      );
    });
  });

  describe("findById", () => {
    test("returns a task by id", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      const found = await A2ATaskModel.findById(task.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(task.id);
      expect(found?.contextId).toBe(context.id);
      expect(found?.state).toBe(A2AProtocolTaskState.Submitted);
    });
  });

  describe("updateState", () => {
    test("updates task state and updatedAt", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      const [beforeUpdate] = await db
        .select()
        .from(schema.a2aTasksTable)
        .where(eq(schema.a2aTasksTable.id, task.id));

      await A2ATaskModel.updateState(task.id, A2AProtocolTaskState.Completed);

      const [updatedTask] = await db
        .select()
        .from(schema.a2aTasksTable)
        .where(eq(schema.a2aTasksTable.id, task.id));

      expect(updatedTask.state).toBe(A2AProtocolTaskState.Completed);
      expect(updatedTask.updatedAt.getTime()).toBeGreaterThan(
        beforeUpdate.updatedAt.getTime(),
      );
      expect((await A2ATaskModel.findById(task.id))?.state).toBe(
        A2AProtocolTaskState.Completed,
      );
    });
  });

  describe("delete", () => {
    test("removes a task", async () => {
      const originalCount = await A2ATaskModel.getTotalCount();
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      expect(await A2ATaskModel.getTotalCount()).toBe(originalCount + 1);

      await A2ATaskModel.delete(task.id);
      expect(await A2ATaskModel.findById(task.id)).toBeNull();
      expect(await A2ATaskModel.getTotalCount()).toBe(originalCount);
    });
  });

  describe("transitionStateWithEvent", () => {
    const workingEvent = (taskId: string, contextId: string) => ({
      statusUpdate: {
        taskId,
        contextId,
        status: { state: A2AProtocolTaskState.Working },
      },
    });

    test("CAS succeeds from an allowed state, appending the event atomically", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      const transitioned = await A2ATaskModel.transitionStateWithEvent({
        id: task.id,
        to: A2AProtocolTaskState.Working,
        allowedFrom: [A2AProtocolTaskState.Submitted],
        eventPayload: workingEvent(task.id, context.id),
      });

      expect(transitioned?.state).toBe(A2AProtocolTaskState.Working);
      expect(transitioned?.stateChangedAt).toBeInstanceOf(Date);

      const read = await A2ATaskModel.readTaskAndEventsAfter({
        taskId: task.id,
        afterSeq: 0,
      });
      expect(read?.events).toHaveLength(1);
      expect(read?.events[0].seq).toBe(1);
    });

    test("CAS from a disallowed state writes nothing — terminal states are absorbing", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Canceled,
      });

      for (const to of [
        A2AProtocolTaskState.Working,
        A2AProtocolTaskState.Completed,
        A2AProtocolTaskState.Failed,
      ]) {
        const transitioned = await A2ATaskModel.transitionStateWithEvent({
          id: task.id,
          to,
          allowedFrom: [
            A2AProtocolTaskState.Submitted,
            A2AProtocolTaskState.Working,
            A2AProtocolTaskState.InputRequired,
          ],
          eventPayload: workingEvent(task.id, context.id),
        });
        expect(transitioned).toBeNull();
      }

      const read = await A2ATaskModel.readTaskAndEventsAfter({
        taskId: task.id,
        afterSeq: 0,
      });
      expect(read?.task.state).toBe(A2AProtocolTaskState.Canceled);
      // The losing transitions appended no events.
      expect(read?.events).toEqual([]);
    });

    test("concurrent transitions: exactly one wins", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Working,
      });

      const results = await Promise.all([
        A2ATaskModel.transitionStateWithEvent({
          id: task.id,
          to: A2AProtocolTaskState.Canceled,
          allowedFrom: [A2AProtocolTaskState.Working],
          eventPayload: workingEvent(task.id, context.id),
        }),
        A2ATaskModel.transitionStateWithEvent({
          id: task.id,
          to: A2AProtocolTaskState.Completed,
          allowedFrom: [A2AProtocolTaskState.Working],
          eventPayload: workingEvent(task.id, context.id),
        }),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe("appendRunDelta", () => {
    test("allocates gapless ordered seqs, mirrors chunks into the artifact, and refuses once the task settles", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Working,
      });
      const artifactId = crypto.randomUUID();

      for (const chunk of ["Hel", "lo ", "world"]) {
        const appended = await A2ATaskModel.appendRunDelta({
          taskId: task.id,
          eventPayload: {
            artifactUpdate: {
              taskId: task.id,
              contextId: context.id,
              artifact: {
                artifactId,
                name: "agent-response",
                parts: [{ text: chunk }],
              },
            },
          },
          artifact: {
            id: artifactId,
            name: "agent-response",
            appendText: chunk,
          },
        });
        expect(appended).not.toBeNull();
      }

      const read = await A2ATaskModel.readTaskAndEventsAfter({
        taskId: task.id,
        afterSeq: 0,
      });
      expect(read?.events.map((e) => e.seq)).toEqual([1, 2, 3]);

      // The artifact row was created with the first chunk and extended since —
      // a snapshot reconstructs everything already emitted.
      const [artifact] = await db
        .select()
        .from(schema.a2aArtifactsTable)
        .where(eq(schema.a2aArtifactsTable.id, artifactId));
      expect(artifact.parts).toEqual([{ text: "Hello world" }]);

      // Once the task leaves the active states, the append guard refuses —
      // this is how a cross-pod cancellation stops a running producer.
      await A2ATaskModel.transitionStateWithEvent({
        id: task.id,
        to: A2AProtocolTaskState.Canceled,
        allowedFrom: [A2AProtocolTaskState.Working],
        eventPayload: {
          statusUpdate: {
            taskId: task.id,
            contextId: context.id,
            status: { state: A2AProtocolTaskState.Canceled },
          },
        },
      });
      const refused = await A2ATaskModel.appendRunDelta({
        taskId: task.id,
        eventPayload: {
          artifactUpdate: {
            taskId: task.id,
            contextId: context.id,
            artifact: {
              artifactId,
              name: "agent-response",
              parts: [{ text: "!" }],
            },
          },
        },
        artifact: { id: artifactId, name: "agent-response", appendText: "!" },
      });
      expect(refused).toBeNull();
    });
  });

  describe("completeRun", () => {
    test("rolls back all outputs when a cancellation already settled the task", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Canceled,
      });
      const before = await A2ATaskModel.readTaskAndEventsAfter({
        taskId: task.id,
        afterSeq: 0,
      });

      const result = await A2ATaskModel.completeRun({
        taskId: task.id,
        agentMessage: {
          id: crypto.randomUUID(),
          contextId: context.id,
          role: "ROLE_AGENT",
          parts: [{ text: "should not persist" }],
          content: { id: "x", role: "assistant", parts: [] },
        },
        artifact: {
          id: crypto.randomUUID(),
          name: "agent-response",
          parts: [{ text: "should not persist" }],
        },
        eventPayloads: [
          {
            statusUpdate: {
              taskId: task.id,
              contextId: context.id,
              status: { state: A2AProtocolTaskState.Completed },
            },
          },
        ],
      });

      expect(result).toBeNull();
      const after = await A2ATaskModel.readTaskAndEventsAfter({
        taskId: task.id,
        afterSeq: 0,
      });
      expect(after?.task.state).toBe(A2AProtocolTaskState.Canceled);
      expect(after?.events).toEqual(before?.events);
      const artifacts = await db
        .select()
        .from(schema.a2aArtifactsTable)
        .where(eq(schema.a2aArtifactsTable.taskId, task.id));
      expect(artifacts).toEqual([]);
    });
  });

  describe("reapStaleRunning", () => {
    test("fails active tasks with stale heartbeats, spares fresh and input-required ones", async () => {
      const context = await createContext();
      const stale = new Date(Date.now() - 60 * 60 * 1000);

      const staleWorking = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Working,
        lastHeartbeatAt: stale,
      });
      const freshWorking = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Working,
        lastHeartbeatAt: new Date(),
      });
      const staleInputRequired = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.InputRequired,
        lastHeartbeatAt: stale,
      });

      const reaped = await A2ATaskModel.reapStaleRunning({
        staleMs: 10 * 60 * 1000,
        statusReason: "orphaned",
        buildEventPayload: (task) => ({
          statusUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            status: { state: A2AProtocolTaskState.Failed },
          },
        }),
      });

      expect(reaped).toBeGreaterThanOrEqual(1);
      expect((await A2ATaskModel.findById(staleWorking.id))?.state).toBe(
        A2AProtocolTaskState.Failed,
      );
      expect((await A2ATaskModel.findById(staleWorking.id))?.statusReason).toBe(
        "orphaned",
      );
      expect((await A2ATaskModel.findById(freshWorking.id))?.state).toBe(
        A2AProtocolTaskState.Working,
      );
      // Input-required tasks wait on a human, not a run — never reaped.
      expect((await A2ATaskModel.findById(staleInputRequired.id))?.state).toBe(
        A2AProtocolTaskState.InputRequired,
      );
    });
  });

  describe("deleteEventsOfTerminalTasksOlderThan", () => {
    test("prunes event logs of long-terminal tasks only", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Working,
      });
      await A2ATaskModel.appendRunDelta({
        taskId: task.id,
        eventPayload: {
          statusUpdate: {
            taskId: task.id,
            contextId: context.id,
            status: { state: A2AProtocolTaskState.Working },
          },
        },
      });
      await A2ATaskModel.transitionStateWithEvent({
        id: task.id,
        to: A2AProtocolTaskState.Completed,
        allowedFrom: [A2AProtocolTaskState.Working],
        eventPayload: {
          statusUpdate: {
            taskId: task.id,
            contextId: context.id,
            status: { state: A2AProtocolTaskState.Completed },
          },
        },
      });

      // Freshly terminal: within retention, kept.
      await A2ATaskModel.deleteEventsOfTerminalTasksOlderThan(60 * 60 * 1000);
      let read = await A2ATaskModel.readTaskAndEventsAfter({
        taskId: task.id,
        afterSeq: 0,
      });
      expect(read?.events.length).toBeGreaterThan(0);

      // Outside retention: pruned. (Backdate the status change directly.)
      await db
        .update(schema.a2aTasksTable)
        .set({ stateChangedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(schema.a2aTasksTable.id, task.id));
      await A2ATaskModel.deleteEventsOfTerminalTasksOlderThan(60 * 60 * 1000);
      read = await A2ATaskModel.readTaskAndEventsAfter({
        taskId: task.id,
        afterSeq: 0,
      });
      expect(read?.events).toEqual([]);
    });
  });
});
