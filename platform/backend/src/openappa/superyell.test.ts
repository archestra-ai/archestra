import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import { describe, expect, test } from "@/test";
import { superyell, superyelled, ungoverned } from "./superyell";

describe("superyell", () => {
  test("takes the session and the children it starts out of OpenAPPA, and no other session", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const session = { organization_id: org.id, session_id: "chat-1" };

    expect(await ungoverned(session)).toBe(false);
    await superyell({ session, userId: user.id });

    expect(await ungoverned(session)).toBe(true);
    expect(
      await ungoverned({ organization_id: org.id, session_id: "chat-2" }),
    ).toBe(false);
    // The same id in another organization is another session.
    const other = await makeOrganization();
    expect(
      await ungoverned({ organization_id: other.id, session_id: "chat-1" }),
    ).toBe(false);

    // A child is out, and so is the grandchild it starts.
    const child = {
      organization_id: org.id,
      session_id: "chat-1/worker",
      parent_id: "chat-1",
    };
    expect(await superyelled(child)).toBe(true);
    expect(
      await superyelled({
        organization_id: org.id,
        session_id: "chat-1/worker/helper",
        parent_id: "chat-1/worker",
      }),
    ).toBe(true);
  });

  test("still leaves a session that started while enforcement was off out of OpenAPPA", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OpenAppaUnenforcedModel.recordSession({
      organizationId: org.id,
      sessionId: "chat-off",
      parentId: undefined,
    });

    expect(
      await ungoverned({ organization_id: org.id, session_id: "chat-off" }),
    ).toBe(true);
  });

  test("a second superyell of the same session does nothing", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const session = { organization_id: org.id, session_id: "chat-1" };
    await superyell({ session, userId: undefined });
    await superyell({ session, userId: undefined });
    expect(await superyelled(session)).toBe(true);
  });
});
