import { replayOpenappaPolicy } from "@archestra/openappa-rs";
import {
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_RUN_COMMAND_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, test } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import { initialPolicy } from "./guardrails-policy";

describe("initialPolicy", () => {
  const fullWhiteLabeling = config.enterpriseFeatures.fullWhiteLabeling;
  afterEach(() => {
    config.enterpriseFeatures.fullWhiteLabeling = fullWhiteLabeling;
    archestraMcpBranding.syncFromOrganization(null);
  });

  test("human review covers only human-approval, without overriding trust, audience, or other marks", async () => {
    const document = parse(initialPolicy());
    const policy = document.policy as ReturnType<typeof parse>;
    const externals = document.externals as ReturnType<typeof parse>;
    const authorities = externals.authorities as ReturnType<typeof parse>;
    expect(authorities.hitl).toEqual({ builtin: "hitl" });

    // Replay cannot ask a human. Substitute only the reviewer implementation;
    // the shipped authority's permissions are enforced by the real engine.
    const content = stringify({
      policy: {
        version: 2,
        authority: policy.authority,
        tool: [
          {
            name: "test__read",
            delta: { trust: "suspicious", audience: ["isolated-reader"] },
          },
          { name: "test__trusted", delta: {}, requires: { trust: "trusted" } },
          {
            name: "test__public",
            delta: {},
            requires: { audience: { contains: ["public"] } },
          },
          {
            name: "test__review",
            delta: {},
            requires: { attention: ["human-approval"] },
          },
          {
            name: "test__custom_review",
            delta: {},
            requires: { attention: ["custom-review"] },
          },
          {
            name: "test__blocked",
            delta: {},
            requires: { attention: ["blocked"] },
          },
        ],
      },
      externals: { authorities: { hitl: { builtin: "approve" } } },
    });
    const result = JSON.parse(
      await replayOpenappaPolicy(
        JSON.stringify({
          content,
          files: [
            ...["trusted", "public", "custom_review"].map((tool) => ({
              path: `${tool}.appa`,
              content: `mcp/test/read {}\nexpect allow\nmcp/test/${tool} {}\nexpect deny\n`,
            })),
            {
              path: "human-approval.appa",
              content:
                "mcp/test/review {}\nexpect authority hitl\nmcp/test/review {}\nexpect authority hitl\n",
            },
            {
              path: "blocked.appa",
              content: "mcp/test/blocked {}\nexpect deny\n",
            },
          ],
        }),
      ),
    );
    expect(result.files).toHaveLength(5);
    for (const file of result.files)
      expect(file, JSON.stringify(file)).toMatchObject({ status: "passed" });

    const humanPolicy = parse(content);
    humanPolicy.externals = { authorities };
    const humanResult = JSON.parse(
      await replayOpenappaPolicy(
        JSON.stringify({
          content: stringify(humanPolicy),
          files: [
            {
              path: "no-review.appa",
              content: "mcp/test/trusted {}\nexpect allow\n",
            },
            {
              path: "human-review.appa",
              content: "mcp/test/review {}\nexpect authority hitl\n",
            },
          ],
        }),
      ),
    );
    expect(
      humanResult.files[0],
      JSON.stringify(humanResult.files[0]),
    ).toMatchObject({ status: "passed" });
    expect(
      humanResult.files[1],
      JSON.stringify(humanResult.files[1]),
    ).toMatchObject({
      status: "cannot_run",
      steps: [{ status: "cannot_run" }],
    });
  });

  test.each([
    ["the default branding", null],
    ["a white-labeled deployment", "Acme Hub"],
  ])("under %s, run_command goes to the archestra annotator, control tools carry no label, and other tools go to noop", (_, appName) => {
    config.enterpriseFeatures.fullWhiteLabeling = appName !== null;
    archestraMcpBranding.syncFromOrganization({ appName, iconLogo: null });

    const { policy } = parse(initialPolicy()) as unknown as {
      policy: {
        annotator: Array<{ name: string; builtin?: string }>;
        tool: Array<{
          name: string;
          annotator?: string;
          delta?: Record<string, unknown>;
        }>;
      };
    };
    // The runtime picks the first rule that matches a call.
    const rule = (tool: string) =>
      policy.tool.find((r) => r.name === tool || r.name === "*");
    const governing = (tool: string) =>
      policy.annotator.find((a) => a.name === rule(tool)?.annotator);

    expect(
      governing(archestraMcpBranding.getToolName(TOOL_RUN_COMMAND_SHORT_NAME)),
    ).toEqual(expect.objectContaining({ builtin: "archestra" }));
    expect(
      rule(archestraMcpBranding.getToolName(TOOL_ASK_USER_SHORT_NAME)),
    ).toEqual({
      name: archestraMcpBranding.getToolName(TOOL_ASK_USER_SHORT_NAME),
      delta: {},
    });
    expect(
      governing(archestraMcpBranding.getToolName(TOOL_TODO_WRITE_SHORT_NAME)),
    ).toEqual({ name: "noop" });
  });
});
