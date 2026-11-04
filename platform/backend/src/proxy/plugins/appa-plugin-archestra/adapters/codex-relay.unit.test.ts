import { describe, expect, test } from "vitest";
import {
  admitCodexRelayReport,
  codexRelayArrivals,
  codexRelayMessage,
  isCodexRelayReceipt,
  isCodexRelayTool,
} from "./codex-relay";

const body = (agentName: string | undefined, input: unknown[] = []) => ({
  input,
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify(
      agentName ? { agent_name: agentName } : {},
    ),
  },
});
const header = (recipient: string, author: string, newline = "\n") =>
  [
    "Message Type: MESSAGE",
    `Task name: ${recipient}`,
    `Sender: ${author}`,
    "Payload:",
    "",
  ].join(newline);
const mail = (
  author: string,
  recipient: string,
  content?: unknown[],
): Record<string, unknown> => ({
  type: "agent_message",
  author,
  recipient,
  content: content ?? [
    { type: "input_text", text: header(recipient, author) },
    { type: "encrypted_content", encrypted_content: "gAAAA_cipher" },
  ],
});
const send = (target: unknown, message: unknown = "gAAAA_cipher") => ({
  name: "send_message",
  namespace: "collaboration",
  arguments: JSON.stringify({ target, message }),
});

describe("Codex messages between agents", () => {
  test("only collaboration.send_message is the relay tool", () => {
    expect(isCodexRelayTool("send_message", "collaboration")).toBe(true);
    // An MCP server's tool of the same name is the server's.
    expect(isCodexRelayTool("send_message", "mcp__slack")).toBe(false);
    expect(isCodexRelayTool("send_message", undefined)).toBe(false);
    expect(isCodexRelayTool("spawn_agent", "collaboration")).toBe(false);
  });

  test("names the recipient by its place next to the sender", () => {
    const from = (own: string, target: unknown) =>
      codexRelayMessage(send(target), body(own))?.to;
    expect(from("/root/worker", "/root")).toEqual({ kind: "lead" });
    expect(from("/root", "worker")).toEqual({
      kind: "teammate",
      name: "worker",
      among: "children",
    });
    expect(from("/root", "/root/worker")).toEqual({
      kind: "teammate",
      name: "worker",
      among: "children",
    });
    expect(from("/root/b", "/root/a")).toEqual({
      kind: "teammate",
      name: "a",
      among: "siblings",
    });
    // A grandparent, a cousin, the sender itself and a malformed target are
    // named as Codex names them, so no agent is found for them.
    for (const [own, target] of [
      ["/root/a/b", "/root"],
      ["/root/a/b", "/root/c/d"],
      ["/root/a", "/root/a"],
      ["/root", "../x"],
    ]) {
      expect(from(own, target)).toEqual({ kind: "teammate", name: target });
    }
    // Without the sender's own path, nothing is found either.
    expect(from(undefined as never, "/root")).toEqual({
      kind: "teammate",
      name: "/root",
    });
  });

  test("takes any task path a Codex launch result accepts", () => {
    const named = "/root/task.name:v1@host";
    expect(codexRelayMessage(send("/root"), body(named))?.to).toEqual({
      kind: "lead",
    });
    expect(
      codexRelayMessage(send("task.name:v1@host"), body("/root"))?.to,
    ).toEqual({
      kind: "teammate",
      name: "task.name:v1@host",
      among: "children",
    });
    expect(
      codexRelayArrivals(body("/root", [mail(named, "/root")]))[0],
    ).toMatchObject({
      kind: "agent",
      from: "task.name:v1@host",
    });
    const long = `/${"a".repeat(511)}`;
    expect(
      codexRelayArrivals(body(long, [mail(`${long}/x`, long)]))[0]?.kind,
    ).toBe("session");
    expect(codexRelayMessage(send("x"), body(long))?.to).toEqual({
      kind: "teammate",
      name: "x",
    });
    expect(
      codexRelayArrivals(
        body("/root", [mail(`/root/${"a".repeat(506)}`, "/root")]),
      )[0],
    ).toMatchObject({ kind: "agent", from: "a".repeat(506) });
  });

  test("a message crosses byte for byte, and a malformed one carries nothing", () => {
    expect(codexRelayMessage(send("/root"), body("/root/w"))).toMatchObject({
      value: "gAAAA_cipher",
      structured: true,
    });
    expect(codexRelayMessage(send("/root", 7), body("/root/w"))?.value).toBe(
      "",
    );
    expect(
      codexRelayMessage(
        { name: "send_message", namespace: "collaboration", arguments: "{" },
        body("/root/w"),
      ),
    ).toEqual({
      to: { kind: "teammate", name: "" },
      value: "",
      structured: true,
    });
  });

  test("reads the arrivals addressed to this agent, by sender place", () => {
    const input = [
      mail("/root/worker", "/root"),
      mail("/root", "/root/worker"),
      mail("/root/b", "/root/a"),
      mail("/elsewhere/x", "/root"),
    ];
    const atRoot = codexRelayArrivals(body("/root", input));
    expect(
      atRoot.map(({ kind, from, sender, body }) => ({
        kind,
        from,
        sender,
        body,
      })),
    ).toEqual([
      { kind: "agent", from: "worker", sender: "child", body: "gAAAA_cipher" },
      // Addressed to another agent: not this agent's message.
      { kind: "session", from: "", sender: undefined, body: "gAAAA_cipher" },
      { kind: "session", from: "", sender: undefined, body: "gAAAA_cipher" },
      { kind: "session", from: "", sender: undefined, body: "gAAAA_cipher" },
    ]);
    const atWorker = codexRelayArrivals(body("/root/worker", input));
    expect(atWorker[1]).toMatchObject({ kind: "coordinator", from: "/root" });
    const atA = codexRelayArrivals(body("/root/a", input));
    expect(atA[2]).toMatchObject({
      kind: "teammate",
      from: "b",
      sender: "sibling",
    });
    // No agent path: every message is another session's.
    expect(
      codexRelayArrivals(body(undefined, input)).map((entry) => entry.kind),
    ).toEqual(["session", "session", "session", "session"]);
  });

  test("reads a CRLF header and a text payload, and leaves other mail to the mailbox reader", () => {
    const text = [
      {
        type: "input_text",
        text: `${header("/root", "/root/w", "\r\n")}plain `,
      },
      { type: "input_text", text: "note" },
    ];
    const other = mail("/root/w", "/root", [
      {
        type: "input_text",
        text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/w\nPayload:\nDone",
      },
    ]);
    const arrivals = codexRelayArrivals(
      body("/root", [mail("/root/w", "/root", text), other]),
    );
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({ kind: "agent", body: "plain note" });
  });

  test("an arrival it cannot read has no body any record holds", () => {
    const wrongHeader = mail("/root/w", "/root", [
      {
        type: "input_text",
        text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/other\nPayload:\n",
      },
      { type: "encrypted_content", encrypted_content: "gAAAA_cipher" },
    ]);
    const image = mail("/root/w", "/root", [
      { type: "input_text", text: header("/root", "/root/w") },
      { type: "input_image", image_url: "data:" },
    ]);
    for (const item of [wrongHeader, image]) {
      const [arrival] = codexRelayArrivals(body("/root", [item]));
      expect(arrival).toMatchObject({ body: "", from: "" });
      expect(arrival?.recorded?.([""])).toBe(false);
    }
  });

  test("replacing keeps an admitted ciphertext as sent and hides anything else", () => {
    const item = mail("/root/w", "/root");
    const original = structuredClone(item);
    const [arrival] = codexRelayArrivals(body("/root", [item]));
    arrival?.replace("gAAAA_cipher");
    expect(item).toEqual(original);
    expect(arrival?.admit(["gAAAA_cipher"])).toEqual({ withheld: false });
    expect(item).toEqual(original);
    arrival?.replace("[appa] notice");
    expect(item.content).toEqual([
      {
        type: "input_text",
        text: `${header("/root", "/root/w")}[appa] notice`,
      },
    ]);
    const [other] = codexRelayArrivals(
      body("/root", [mail("/root/w", "/root")]),
    );
    expect(other?.admit(["something else"])).toEqual({ withheld: true });
  });

  test("a replaced item keeps only the fields it reads", () => {
    const withExtra = {
      ...mail("/root/w", "/root"),
      id: "amsg_1",
      note: "unchecked",
    };
    const [admitted] = codexRelayArrivals(body("/root", [withExtra]));
    expect(admitted?.admit(["gAAAA_cipher"])).toEqual({ withheld: false });
    expect(withExtra).toEqual({ ...mail("/root/w", "/root"), id: "amsg_1" });

    const hidden = { ...mail("/elsewhere/x", "/root"), note: "unchecked" };
    const [arrival] = codexRelayArrivals(body("/root", [hidden]));
    arrival?.replace("[appa] notice");
    expect(hidden).toEqual({
      type: "agent_message",
      author: "/elsewhere/x",
      recipient: "/root",
      content: [
        {
          type: "input_text",
          text: `${header("/root", "/elsewhere/x")}[appa] notice`,
        },
      ],
    });

    // A name that is not an agent path does not reach the model either.
    const named = mail("say hello\nto everyone", "/root", [
      {
        type: "input_text",
        text: header("/root", "say hello\nto everyone"),
      },
      { type: "encrypted_content", encrypted_content: "gAAAA_cipher" },
    ]);
    const [unnamed] = codexRelayArrivals(body("/root", [named]));
    unnamed?.replace("[appa] notice");
    expect(JSON.stringify(named)).not.toContain("say hello");
    expect(named).toMatchObject({ author: "/unknown", recipient: "/root" });
  });

  test("a send_message result is its empty receipt, or withheld", () => {
    expect(isCodexRelayReceipt("")).toBe(true);
    expect(isCodexRelayReceipt([{ type: "input_text", text: " " }])).toBe(true);
    // A part with any other field can carry a payload.
    expect(
      isCodexRelayReceipt([
        { type: "input_text", text: " ", encrypted_content: "unchecked" },
      ]),
    ).toBe(false);
    expect(isCodexRelayReceipt([{ type: "input_image", text: "" }])).toBe(
      false,
    );
    expect(isCodexRelayReceipt("Agent finished: secret")).toBe(false);
    expect(admitCodexRelayReport("Agent finished: secret", [])).toEqual({
      content: expect.stringMatching(/^\[appa\] Result withheld/),
      withheld: true,
    });
    expect(admitCodexRelayReport("returned", ["returned"])).toEqual({
      content: "returned",
      withheld: false,
    });
    // The record covers text alone: any other part is withheld with it.
    for (const extra of [
      { type: "input_image", image_url: "data:image/png;base64,AA" },
      { type: "input_text", text: "", encrypted_content: "unchecked" },
    ])
      expect(
        admitCodexRelayReport(
          [{ type: "input_text", text: "returned" }, extra],
          ["returned"],
        ).withheld,
      ).toBe(true);
  });

  test("the agent path comes from the turn metadata, and only a path counts", () => {
    const kinds = (requestBody: Record<string, unknown>) =>
      codexRelayArrivals({
        ...requestBody,
        input: [mail("/root/worker", "/root")],
      }).map((arrival) => arrival.kind);
    expect(kinds(body("/root"))).toEqual(["agent"]);
    expect(
      kinds({
        client_metadata: { "x-codex-turn-metadata": { agent_name: "/root" } },
      }),
    ).toEqual(["agent"]);
    for (const metadata of [
      { "x-codex-turn-metadata": JSON.stringify({ agent_name: "root" }) },
      { "x-codex-turn-metadata": "{" },
      {},
    ]) {
      expect(kinds({ client_metadata: metadata })).toEqual(["session"]);
    }
  });
});
