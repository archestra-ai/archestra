import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { NativeSession } from "./native-session.js";

const sessions: NativeSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("Codex streams Unicode, tools and input requests, then restores the provider thread", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "agent-session-"));
  directories.push(runtimeDir);
  const session = makeSession({ provider: "codex", runtimeDir, script: CODEX });
  await session.start("Read the file");
  await vi.waitFor(() =>
    expect(session.snapshot.session.state).toBe("input_required"),
  );
  expect(session.snapshot.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "Hello 🌱",
      }),
      expect.objectContaining({ type: "tool_result", text: "file contents" }),
    ]),
  );
  await expect(
    session.control({ type: "message", text: "another" }),
  ).rejects.toThrow("current turn");
  const request = session.snapshot.session.requests[0];
  if (!request) throw new Error("Missing request");
  expect(request?.questions?.[0]?.text).toBe("Which color?");
  await expect(
    session.control({ type: "respond", requestId: request.id, answers: {} }),
  ).rejects.toThrow("every question");
  await session.control({
    type: "respond",
    requestId: request.id,
    answers: { color: "blue" },
  });
  await vi.waitFor(() => expect(session.snapshot.session.state).toBe("idle"));
  await expect(
    session.control({
      type: "respond",
      requestId: request.id,
      answers: { color: "red" },
    }),
  ).rejects.toThrow("already been answered");
  await vi.waitFor(async () =>
    expect(
      JSON.parse(
        await readFile(path.join(runtimeDir, "codex-web-session.json"), "utf8"),
      ).sessionId,
    ).toBe("thread-1"),
  );
  session.close();
  const resumed = makeSession({
    provider: "codex",
    runtimeDir,
    continuing: true,
    script: CODEX,
  });
  await resumed.start("Follow up");
  await vi.waitFor(() =>
    expect(
      resumed.snapshot.entries.some(
        (entry) =>
          entry.type === "message" && entry.text === "resumed thread-1",
      ),
    ).toBe(true),
  );
});

test.each([
  "opencode",
  "hermes",
  "openclaw",
] as const)("%s translates ACP permissions and turn completion", async (provider) => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "agent-session-"));
  directories.push(runtimeDir);
  const session = makeSession({ provider, runtimeDir, script: ACP });
  await session.start("Inspect the file");
  await vi.waitFor(() =>
    expect(session.snapshot.session.state).toBe("input_required"),
  );
  expect(
    session.snapshot.entries.find((entry) => entry.type === "tool_result"),
  ).toMatchObject({ text: "", isError: false });
  const request = session.snapshot.session.requests[0];
  if (!request) throw new Error("Missing request");
  await expect(
    session.control({
      type: "respond",
      requestId: request.id,
      optionId: "invented",
    }),
  ).rejects.toThrow("available response");
  await session.control({
    type: "respond",
    requestId: request.id,
    optionId: "allow-once",
  });
  await vi.waitFor(() => expect(session.snapshot.session.state).toBe("idle"));
  expect(session.snapshot.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "message", text: "Read complete" }),
      expect.objectContaining({ type: "tool_result", text: "hello" }),
    ]),
  );
  await session.shutdown();
  const resumed = makeSession({
    provider,
    runtimeDir,
    script: ACP,
    continuing: true,
  });
  await resumed.start("Follow up");
  await vi.waitFor(() =>
    expect(resumed.snapshot.session.state).toBe("input_required"),
  );
  expect(
    resumed.snapshot.entries.filter(
      (entry) => entry.type === "message" && entry.text === "Read complete",
    ),
  ).toHaveLength(1);
});

test("Claude reconciles streamed text with the completed message without duplication", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "agent-session-"));
  directories.push(runtimeDir);
  const session = makeSession({
    provider: "claude-code",
    runtimeDir,
    script: CLAUDE,
  });
  await session.start("Hello");
  await vi.waitFor(() => expect(session.snapshot.session.state).toBe("idle"));
  expect(
    session.snapshot.entries.filter(
      (entry) => entry.type === "message" && entry.role === "assistant",
    ),
  ).toEqual([
    { id: "message-1:0", type: "message", role: "assistant", text: "Hello 🌱" },
  ]);
});

function makeSession(params: {
  provider: "codex" | "claude-code" | "opencode" | "hermes" | "openclaw";
  runtimeDir: string;
  script: string;
  continuing?: boolean;
}) {
  const session = new NativeSession({
    provider: params.provider,
    runtimeDir: params.runtimeDir,
    continuing: params.continuing ?? false,
    command: [process.execPath, "--input-type=module", "-e", params.script],
    onChange: () => {},
    onDone: () => {},
  });
  sessions.push(session);
  return session;
}

const PREFIX = `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const result = (id, result) => send({jsonrpc:'2.0',id,result});
createInterface({input:process.stdin}).on('line', (line) => {
const message=JSON.parse(line);
`;
const CODEX =
  PREFIX +
  `
if (message.method==='initialize') result(message.id, {});
if (message.method==='thread/start'||message.method==='thread/resume') {
  result(message.id,{thread:{id:'thread-1'}});
  if(message.method==='thread/resume') send({method:'item/completed',params:{item:{id:'resume',type:'agentMessage',text:'resumed '+message.params.threadId}}});
}
if(message.method==='turn/start') {
 result(message.id,{turn:{id:'turn-1'}});
 send({method:'item/agentMessage/delta',params:{threadId:'thread-1',itemId:'answer',delta:'Hello 🌱'}});
 send({method:'item/completed',params:{item:{id:'tool-1',type:'commandExecution',command:'cat file',aggregatedOutput:'file contents'}}});
 send({id:'question-1',method:'item/tool/requestUserInput',params:{questions:[{id:'color',question:'Which color?',options:[{label:'blue'}]}]}});
}
if(message.id==='question-1') {
 if(message.result.answers.color.answers[0]!=='blue') process.exit(2);
 send({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'}}});
}
});`;
const ACP =
  PREFIX +
  `
if(message.method==='initialize') result(message.id,{agentCapabilities:{loadSession:true}});
if(message.method==='session/new') result(message.id,{sessionId:'session-1'});
if(message.method==='session/load') {
 send({method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Read complete'}}}});
 result(message.id,{});
}
if(message.method==='session/prompt') {
 globalThis.promptId=message.id;
 send({method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'tool_call',toolCallId:'call-1',title:'Read file',rawInput:{path:'file'},content:[]}}});
 send({id:'permission',method:'session/request_permission',params:{toolCall:{title:'Read file'},options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'}]}});
}
if(message.id==='permission') {
 if(message.result.outcome.optionId!=='allow-once') process.exit(2);
 send({method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'tool_call_update',toolCallId:'call-1',status:'completed',content:[{type:'content',content:{type:'text',text:'hello'}}]}}});
 send({method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Read complete'}}}});
 result(globalThis.promptId,{stopReason:'end_turn'});
}
});`;
const CLAUDE =
  PREFIX +
  `
if(message.type==='user') {
 send({type:'system',subtype:'init',session_id:'session-1'});
 send({type:'stream_event',event:{type:'message_start',message:{id:'message-1'}}});
 send({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello 🌱'}}});
 send({type:'assistant',message:{id:'message-1',content:[{type:'text',text:'Hello 🌱'}]}});
 send({type:'result',session_id:'session-1',is_error:false});
}
});`;
