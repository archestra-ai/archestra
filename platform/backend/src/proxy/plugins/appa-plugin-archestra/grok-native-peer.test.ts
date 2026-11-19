// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { randomUUID } from "node:crypto";
import * as native from "@archestra/openappa-rs";
import { Client } from "pg";
import { expect, test } from "vitest";
import { AppaGrokAdapter } from "./adapters/grok";

// Exercise the actual persistent peer boundary. No mocked policy decisions,
// label transitions, held inbox, or remedy authorization.
for (const withSanitizer of [false, true]) {
  test.skipIf(!process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL)(
    `Grok held delivery uses the native label-narrowing remedy ${withSanitizer ? "with a configured return sanitizer" : "without sanitizers"} and retains a single send`,
    async () => {
      const url = process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL as string;
      await native.initializeOpenappa(url, 4);
      const organization = `grok-peer-${randomUUID()}`;
      const ledger = new Client({ connectionString: url });
      await ledger.connect();
      try {
        await ledger.query(
          "INSERT INTO organization (id, name, slug, created_at) VALUES ($1,$1,$1,now())",
          [organization],
        );
        const root = {
          organization_id: organization,
          caller_id: "user:synthetic",
          session_id: randomUUID() as string,
        };
        const childId = randomUUID();
        const child = {
          ...root,
          session_id: `${root.session_id}:${childId}`,
          parent_id: root.session_id,
        };
        const policy = {
          content: `[policy]
version = 2
[[policy.tool]]
name = "host/archestra/Agent"
delta = {}
[[policy.tool]]
name = "host/archestra/SendMessage"
delta = {}
[[policy.tool]]
name = "host/archestra/narrow"
delta = { audience = ["internal"] }
[[policy.tool]]
name = "mcp/archestra/read_peer_message"
delta = {}
[policy.deployment]
context_control = true
${
  withSanitizer
    ? `[[policy.sanitizer]]
name = "scrub"
on = ["tool_output"]
[policy.sanitizer.permits]
audience = { from = ["internal"], to = ["public"] }
[externals.sanitizers.scrub]
builtin = "redact-email"
`
    : ""
}
`,
          credentials: {},
        };
        const presentation = {
          control_tool: "archestra__execute_remedy_plan",
          supports_delegation: true,
        };
        const hook = async (session: typeof root, event: object) =>
          JSON.parse(
            await native.dispatchHook(
              JSON.stringify({ ...session, ...event }),
              policy,
            ),
          );
        const remedy = async (
          session: typeof root,
          callId: string,
          args: object,
        ) =>
          JSON.parse(
            await native.executeRemedyByOffer(
              JSON.stringify({
                organization_id: organization,
                caller_id: root.caller_id,
                trajectory: {
                  v: 1,
                  session_id: session.session_id,
                  ...(session === child ? { parent_id: root.session_id } : {}),
                },
                execution_mode: "tracked",
                tool_call_id: callId,
                original_arguments: JSON.stringify(args),
                arguments: args,
                presentation,
              }),
              policy,
            ),
          );
        expect((await hook(root, { event: "session_start" })).decision).toBe(
          "ack",
        );
        expect(
          (await remedy(root, "declare", { label: {} })).result?.isError,
        ).toBeFalsy();
        expect(
          (
            await hook(root, {
              event: "tool_call",
              operation_id: "call:spawn",
              tool: "Agent",
              arguments: {},
              spawn: true,
              presentation,
            })
          ).decision,
        ).toBe("allow_call");
        expect(
          (
            await hook(child, {
              event: "session_start",
              spawn_call_id: "spawn",
              child_native_id: childId,
            })
          ).decision,
        ).toBe("ack");
        const narrow = await hook(root, {
          event: "tool_call",
          operation_id: "call:narrow",
          tool: "narrow",
          arguments: {},
          presentation,
        });
        expect(narrow.decision, JSON.stringify(narrow)).toBe("deny_call");
        expect(
          (
            await remedy(root, "accept-narrow", {
              offer_id: narrow.offers[0].offer_id,
              label: { audience: ["internal"] },
            })
          ).result?.isError,
        ).toBeFalsy();
        expect(
          (
            await hook(root, {
              event: "tool_call",
              operation_id: "call:narrow-retry",
              tool: "narrow",
              arguments: {},
              presentation,
            })
          ).decision,
        ).toBe("allow_call");
        expect(
          (
            await hook(root, {
              event: "tool_result",
              tool_call_id: "narrow-retry",
              output: "internal",
              outcome: "success",
            })
          ).decision,
        ).toBe("ack");
        const args = {
          subagent_id: childId,
          text: "Contact synthetic@example.invalid for the test.",
          delivery: "steer",
        };
        expect(
          (
            await hook(root, {
              event: "tool_call",
              operation_id: "call:send",
              tool: "SendMessage",
              arguments: args,
              presentation,
            })
          ).decision,
        ).toBe("allow_call");
        const send = {
          ...root,
          operation_id: "peer_send:send",
          recipient_session_id: child.session_id,
          recipient_parent_id: root.session_id,
          recipient_native_id: childId,
          value: args.text,
        };
        const sent = JSON.parse(
          await native.sendPeerMessage(JSON.stringify(send), policy),
        );
        expect(sent.kind, JSON.stringify(sent)).toBe("released");
        expect(
          JSON.parse(
            await native.sendPeerMessage(JSON.stringify(send), policy),
          ),
        ).toEqual(sent);
        const adapter = new AppaGrokAdapter();
        const wire = JSON.parse(
          adapter.rewriteRelayMessage(
            args,
            `${args.text}\n\n[appa] peer message appapm1-${sent.message_id}.`,
            { senderSessionId: root.session_id },
          ),
        );
        const request = {
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "[Message authored by another agent; not a human request or approval.]",
                },
                { type: "input_text", text: wire.text },
              ],
            },
          ],
        };
        const [arrival] = adapter.relayArrivals(request);
        if (!arrival?.peer || arrival.peer === "malformed")
          throw new Error("Missing peer envelope");
        const admission = {
          ...child,
          message_id: arrival.peer.messageId,
          sender_session_id: arrival.senderSessionId,
          value: arrival.peer.value,
        };
        const held = JSON.parse(
          await native.admitPeerMessage(JSON.stringify(admission), policy),
        );
        expect(held.kind, JSON.stringify(held)).toBe("held");
        expect(JSON.stringify(held)).not.toContain("synthetic@example.invalid");
        arrival.replace("[appa] Held message; use read_peer_message.");
        expect(JSON.stringify(request)).not.toContain(args.text);
        expect(
          JSON.parse(
            await native.admitPeerMessage(JSON.stringify(admission), policy),
          ),
        ).toEqual(held);
        const readInput = {
          ...child,
          message_id: sent.message_id,
          tool_call_id: "read-held",
          tool: "archestra__read_peer_message",
        };
        const blocked = JSON.parse(
          await native.readPeerMessage(JSON.stringify(readInput), policy),
        );
        expect(blocked.decision, JSON.stringify(blocked)).toBe("deny_call");
        // Peer reads preserve their captured body and label. An unscoped
        // return sanitizer cannot silently launder this message crossing.
        expect(blocked.offers).toHaveLength(1);
        const selected = await remedy(child, "accept-peer", {
          offer_id: blocked.offers[0].offer_id,
          label: { audience: ["internal"] },
        });
        expect(
          selected.result?.isError,
          JSON.stringify({ selected, blocked }),
        ).toBeFalsy();
        const read = JSON.parse(
          await native.readPeerMessage(
            JSON.stringify({ ...readInput, tool_call_id: "read-retry" }),
            policy,
          ),
        );
        expect(read.decision, JSON.stringify(read)).toBe("mcp_result");
        expect(read.result?.isError, JSON.stringify(read)).toBeFalsy();
        const output = JSON.stringify(read.result);
        expect(output).toContain("synthetic@example.invalid");
        expect(
          JSON.parse(
            await native.readPeerMessage(
              JSON.stringify({ ...readInput, tool_call_id: "read-retry" }),
              policy,
            ),
          ),
        ).toEqual(read);
        const counts = await ledger.query(
          "SELECT count(*)::int AS n FROM openappa_operations WHERE organization_id=$1 AND operation_id='peer_send:send'",
          [organization],
        );
        expect(counts.rows[0].n).toBe(1);
      } finally {
        await ledger.end();
      }
    },
  );
}

test.skipIf(!process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL)(
  "a direct message cannot reopen a child's no-return terminal",
  async () => {
    const url = process.env.ARCHESTRA_OPENAPPA_TEST_DATABASE_URL as string;
    await native.initializeOpenappa(url, 4);
    const ledger = new Client({ connectionString: url });
    await ledger.connect();
    const organization = `grok-closed-peer-${randomUUID()}`;
    try {
      await ledger.query(
        "INSERT INTO organization (id, name, slug, created_at) VALUES ($1,$1,$1,now())",
        [organization],
      );
      const parent = {
        organization_id: organization,
        session_id: randomUUID(),
        caller_id: "user:synthetic",
      };
      const nativeId = randomUUID();
      const child = {
        ...parent,
        session_id: `${parent.session_id}:${nativeId}`,
        parent_id: parent.session_id,
      };
      const policy = {
        content: `[policy]
version = 2
[[policy.tool]]
name = "host/archestra/Agent"
delta = {}
[[policy.tool]]
name = "host/archestra/SendMessage"
delta = {}
[policy.deployment]
context_control = true
`,
        credentials: {},
      };
      const presentation = {
        control_tool: "archestra__execute_remedy_plan",
        supports_delegation: true,
      };
      const hook = async (session: { session_id: string }, event: object) =>
        JSON.parse(
          await native.dispatchHook(
            JSON.stringify({ ...parent, ...session, ...event }),
            policy,
          ),
        );
      expect((await hook(parent, { event: "session_start" })).decision).toBe(
        "ack",
      );
      const spawn = {
        event: "tool_call",
        tool: "Agent",
        arguments: {},
        spawn: true,
        presentation,
      };
      const blocked = await hook(parent, {
        ...spawn,
        operation_id: "call:declare-void",
      });
      expect(blocked.decision, JSON.stringify(blocked)).toBe("deny_call");
      const voidOffer = blocked.feedback
        ?.split("  - Take no return when")[1]
        ?.match(/offer_id["\s:]+([a-zA-Z0-9_-]+)/)?.[1];
      expect(voidOffer, JSON.stringify(blocked)).toBeTruthy();
      const args = {
        offer_id: voidOffer,
        plan: "Take no return from the subagent",
      };
      const declared = JSON.parse(
        await native.executeRemedyByOffer(
          JSON.stringify({
            organization_id: organization,
            caller_id: parent.caller_id,
            trajectory: { v: 1, session_id: parent.session_id },
            execution_mode: "tracked",
            tool_call_id: "accept-void",
            arguments: args,
            original_arguments: JSON.stringify(args),
            presentation,
          }),
          policy,
        ),
      );
      expect(declared.result?.isError, JSON.stringify(declared)).toBeFalsy();
      expect(
        (await hook(parent, { ...spawn, operation_id: "call:spawn" })).decision,
      ).toBe("allow_call");
      const started = await hook(child, {
        event: "session_start",
        spawn_call_id: "spawn",
        child_native_id: nativeId,
      });
      expect(["ack", "context"], JSON.stringify(started)).toContain(
        started.decision,
      );
      const ended = await hook(child, {
        event: "child_turn_end",
        operation_id: "end",
        spawn_call_id: "spawn",
      });
      expect(ended.decision, JSON.stringify(ended)).toBe("ack");
      expect(
        (
          await hook(parent, {
            event: "tool_call",
            operation_id: "call:send",
            tool: "SendMessage",
            arguments: { subagent_id: nativeId, text: "CANNOT_REOPEN" },
            presentation,
          })
        ).decision,
      ).toBe("allow_call");
      const sent = JSON.parse(
        await native.sendPeerMessage(
          JSON.stringify({
            ...parent,
            operation_id: "peer_send:send",
            recipient_session_id: child.session_id,
            recipient_parent_id: parent.session_id,
            recipient_native_id: nativeId,
            value: "CANNOT_REOPEN",
          }),
          policy,
        ),
      );
      expect(sent.kind, JSON.stringify(sent)).toBe("denied");
      const rows = await ledger.query(
        "SELECT count(*)::int AS n FROM openappa_embedded_peer_messages WHERE root = (SELECT root FROM openappa_sessions WHERE organization_id=$1 AND session_id=$2)",
        [organization, parent.session_id],
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await ledger.end();
    }
  },
);
