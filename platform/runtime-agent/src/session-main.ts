#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { NativeSession } from "./native-session.js";
import { SessionMailbox } from "./session-mailbox.js";
import { NativeSessionProviderSchema } from "./session-protocol.js";
import { SessionPublisher } from "./session-publisher.js";

async function main(): Promise<void> {
  const [providerArgument, ...command] = process.argv.slice(2);
  const provider = NativeSessionProviderSchema.parse(providerArgument);
  const runtimeDir =
    process.env.ARCHESTRA_AGENT_RUNTIME_DIR ?? "/var/run/archestra";
  const taskId = process.env.ARCHESTRA_AGENT_RUNTIME_TASK_ID;
  if (!taskId || !/^[a-zA-Z0-9-]+$/.test(taskId))
    throw new Error("Missing task ID");

  let dirty = true;
  let stopped = false;
  let exitCode = 0;
  const session = new NativeSession({
    provider,
    command,
    runtimeDir,
    continuing: process.env.ARCHESTRA_AGENT_RUNTIME_CONTINUE === "1",
    onChange: () => {
      dirty = true;
    },
    onDone: (failed) => {
      if (
        failed ||
        process.env.ARCHESTRA_AGENT_RUNTIME_MODE !== "interactive"
      ) {
        exitCode = failed ? 1 : 0;
        stopped = true;
      }
    },
  });
  const mailbox = new SessionMailbox({
    runtimeDir,
    taskId,
    control: (control) => session.control(control),
  });
  const mailboxWork = mailbox.start().catch(() => {
    stopped = true;
    exitCode = 1;
    session.close();
  });
  const stop = () => {
    stopped = true;
    exitCode = 130;
    session.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const publisher = new SessionPublisher(runtimeDir);
  const publish = async () => {
    if (!dirty) return;
    dirty = false;
    await publisher.publish(session.snapshot);
  };
  try {
    await publish();
    const start = session
      .start(process.env.ARCHESTRA_AGENT_RUNTIME_TASK ?? "")
      .catch(() => {
        session.snapshot.session = {
          state: "failed",
          requests: [],
          error:
            "Could not start the agent session. Check its runtime configuration.",
        };
        dirty = true;
        stopped = true;
        exitCode = 1;
      });
    while (!stopped) {
      await publish();
      await delay(250);
    }
    await start;
    if (exitCode === 130)
      session.snapshot.session = { state: "stopped", requests: [] };
    dirty = true;
    await publish();
    const answer = session.snapshot.entries.findLast(
      (entry) => entry.type === "message" && entry.role === "assistant",
    );
    if (answer?.type === "message")
      process.stdout.write(
        `\n===ARCHESTRA-FINAL-ANSWER===\n${answer.text}\n===ARCHESTRA-FINAL-ANSWER-END===\n`,
      );
  } finally {
    mailbox.stop();
    await session.shutdown();
    await mailboxWork;
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  process.exitCode = exitCode;
}

void main().catch(() => {
  process.stderr.write("Could not run the structured agent session.\n");
  process.exitCode = 1;
});
