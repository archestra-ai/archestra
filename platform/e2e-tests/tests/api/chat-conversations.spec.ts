import { expect, test } from "./fixtures";

test.describe("Chat Conversations - Pin/Unpin", () => {
  test("can pin and unpin a conversation", async ({
    request,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const agentResponse = await createAgent(request, "Pin Test Agent");
    const agent = await agentResponse.json();

    try {
      // Create a conversation
      const convResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/chat/conversations",
        data: {
          agentId: agent.id,
          selectedModel: "gpt-4o",
        },
      });
      const conversation = await convResponse.json();
      expect(conversation.pinnedAt).toBeNull();

      // Pin the conversation
      const pinResponse = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: `/api/chat/conversations/${conversation.id}`,
        data: {
          pinnedAt: new Date().toISOString(),
        },
      });
      const pinnedConv = await pinResponse.json();
      expect(pinnedConv.pinnedAt).not.toBeNull();

      // Verify it appears as pinned when fetching
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/chat/conversations/${conversation.id}`,
      });
      const fetchedConv = await getResponse.json();
      expect(fetchedConv.pinnedAt).not.toBeNull();

      // Unpin the conversation
      const unpinResponse = await makeApiRequest({
        request,
        method: "patch",
        urlSuffix: `/api/chat/conversations/${conversation.id}`,
        data: {
          pinnedAt: null,
        },
      });
      const unpinnedConv = await unpinResponse.json();
      expect(unpinnedConv.pinnedAt).toBeNull();
    } finally {
      await deleteAgent(request, agent.id);
    }
  });

  test("returns 404 for non-existent conversation", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/chat/conversations/00000000-0000-4000-8000-000000000000",
      data: { pinnedAt: new Date().toISOString() },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });
});
