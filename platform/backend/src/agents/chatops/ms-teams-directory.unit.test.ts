import { Activity } from "@microsoft/agents-activity";
import {
  CloudAdapter,
  ConnectorClient,
  TurnContext,
} from "@microsoft/agents-hosting";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { msTeamsDirectory } from "./ms-teams-directory";

describe("Teams directory over the authenticated connector", () => {
  useMswServer(
    http.get(
      "https://smba.trafficmanager.net/amer/v3/conversations/:conversation/members/:user",
      ({ request, params }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer connector-token",
        );
        return HttpResponse.json({
          id: params.user,
          email: `${params.conversation}@example.com`,
        });
      },
    ),
    http.get(
      "https://smba.trafficmanager.net/amer/v3/teams/:team",
      ({ request, params }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer connector-token",
        );
        return HttpResponse.json({
          id: params.team,
          name: "Test team",
          aadGroupId: "group-id",
        });
      },
    ),
    http.get(
      "https://smba.trafficmanager.net/amer/v3/teams/:team/conversations",
      () =>
        HttpResponse.json({
          conversations: [{ id: "channel-1", name: "General" }],
        }),
    ),
  );

  test.each([
    "personal",
    "groupChat",
    "channel",
  ])("looks up the sender in the correct %s membership", async (conversationType) => {
    const context = makeContext(conversationType);
    expect(await msTeamsDirectory.getMember(context, "sender")).toMatchObject({
      id: "sender",
      email: `${conversationType === "channel" ? "team" : "chat"}@example.com`,
    });
  });

  test("discovers a channel's team identity and channels", async () => {
    const context = makeContext("channel");
    expect(await msTeamsDirectory.getTeamDetails(context)).toMatchObject({
      name: "Test team",
      aadGroupId: "group-id",
    });
    expect(await msTeamsDirectory.getTeamChannels(context)).toEqual([
      { id: "channel-1", name: "General" },
    ]);
  });

  test("refuses directory calls without an authenticated connector", () => {
    const adapter = new CloudAdapter();
    const context = new TurnContext(
      adapter,
      Activity.fromObject({
        type: "message",
        channelId: "msteams",
        conversation: { id: "chat" },
      }),
    );
    expect(() => msTeamsDirectory.getMember(context, "sender")).toThrow(
      "Missing authenticated Teams connector",
    );
  });
});

function makeContext(conversationType: string) {
  const adapter = new CloudAdapter();
  const context = new TurnContext(
    adapter,
    Activity.fromObject({
      type: "message",
      channelId: "msteams",
      conversation: { id: "chat", conversationType },
      ...(conversationType === "channel" && {
        channelData: { team: { id: "team" } },
      }),
    }),
  );
  context.turnState.set(
    adapter.ConnectorClientKey,
    ConnectorClient.createClientWithToken(
      "https://smba.trafficmanager.net/amer/",
      "connector-token",
    ),
  );
  return context;
}
