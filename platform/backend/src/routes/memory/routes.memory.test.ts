import MemoryItemModel from "@/models/memory-item";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("memory routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let ownerUser: User;
  let outsiderUser: User;
  let currentUser: User;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    ownerUser = await makeUser();
    outsiderUser = await makeUser();
    currentUser = ownerUser;

    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(ownerUser.id, organizationId, { role: "member" });
    await makeMember(outsiderUser.id, organizationId, { role: "member" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: memoryRoutes } = await import("./routes.memory");
    await app.register(memoryRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("covers list/stats/pending/get/create/update/supersede/review/archive/delete lifecycle", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/memory",
      payload: {
        scopeType: "user",
        scopeId: ownerUser.id,
        kind: "preference",
        content: "Prefer concise responses",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.status).toBe("candidate");

    const statsAfterCreate = await app.inject({
      method: "GET",
      url: "/api/memory/stats",
    });
    expect(statsAfterCreate.statusCode).toBe(200);
    expect(statsAfterCreate.json()).toMatchObject({
      candidate: 1,
      approved: 0,
      rejected: 0,
      archived: 0,
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/memory?limit=20&offset=0",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(
      listResponse.json().data.map((item: { id: string }) => item.id),
    ).toContain(created.id);

    const pendingResponse = await app.inject({
      method: "GET",
      url: "/api/memory/pending?limit=20&offset=0",
    });
    expect(pendingResponse.statusCode).toBe(200);
    expect(
      pendingResponse.json().data.map((item: { id: string }) => item.id),
    ).toContain(created.id);

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/memory/${created.id}`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().id).toBe(created.id);

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/memory/${created.id}`,
      payload: {
        content: "Prefer concise and direct responses",
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().content).toBe(
      "Prefer concise and direct responses",
    );

    const approveResponse = await app.inject({
      method: "POST",
      url: `/api/memory/${created.id}/approve`,
    });
    expect(approveResponse.statusCode).toBe(200);
    expect(approveResponse.json().status).toBe("approved");

    const supersedeResponse = await app.inject({
      method: "POST",
      url: `/api/memory/${created.id}/supersede`,
      payload: {
        content: "Prefer bullet points for final answers",
      },
    });
    expect(supersedeResponse.statusCode).toBe(200);
    const supersedingCandidate = supersedeResponse.json();
    expect(supersedingCandidate.status).toBe("candidate");

    const rejectResponse = await app.inject({
      method: "POST",
      url: `/api/memory/${supersedingCandidate.id}/reject`,
      payload: {
        rejectionReason: "duplicate",
      },
    });
    expect(rejectResponse.statusCode).toBe(200);
    expect(rejectResponse.json().status).toBe("rejected");

    const archiveResponse = await app.inject({
      method: "POST",
      url: `/api/memory/${created.id}/archive`,
    });
    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().status).toBe("archived");

    const unarchiveResponse = await app.inject({
      method: "POST",
      url: `/api/memory/${created.id}/unarchive`,
    });
    expect(unarchiveResponse.statusCode).toBe(200);
    expect(unarchiveResponse.json().status).toBe("candidate");

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/memory/${supersedingCandidate.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });

    const deletedGetResponse = await app.inject({
      method: "GET",
      url: `/api/memory/${supersedingCandidate.id}`,
    });
    expect(deletedGetResponse.statusCode).toBe(404);
  });

  test("returns 403 for unauthorized create and 404 for hidden resources", async () => {
    const ownerItem = await MemoryItemModel.create({
      organizationId,
      scopeType: "user",
      scopeId: ownerUser.id,
      kind: "preference",
      status: "candidate",
      content: "Owner private candidate",
      createdBy: ownerUser.id,
      policyFlags: [],
    });

    currentUser = outsiderUser;

    const forbiddenCreate = await app.inject({
      method: "POST",
      url: "/api/memory",
      payload: {
        scopeType: "user",
        scopeId: ownerUser.id,
        kind: "instruction",
        content: "Try writing into someone else's user scope",
      },
    });
    expect(forbiddenCreate.statusCode).toBe(403);

    const hiddenGet = await app.inject({
      method: "GET",
      url: `/api/memory/${ownerItem.id}`,
    });
    expect(hiddenGet.statusCode).toBe(404);

    const missingGet = await app.inject({
      method: "GET",
      url: `/api/memory/${crypto.randomUUID()}`,
    });
    expect(missingGet.statusCode).toBe(404);
  });

  test("returns 409 for invalid transition/update operations", async () => {
    const candidate = await MemoryItemModel.create({
      organizationId,
      scopeType: "user",
      scopeId: ownerUser.id,
      kind: "preference",
      status: "candidate",
      content: "Candidate for transition checks",
      createdBy: ownerUser.id,
      policyFlags: [],
    });

    const approveResponse = await app.inject({
      method: "POST",
      url: `/api/memory/${candidate.id}/approve`,
    });
    expect(approveResponse.statusCode).toBe(200);

    const updateApproved = await app.inject({
      method: "PATCH",
      url: `/api/memory/${candidate.id}`,
      payload: {
        content: "Cannot patch approved item",
      },
    });
    expect(updateApproved.statusCode).toBe(409);

    const reapprove = await app.inject({
      method: "POST",
      url: `/api/memory/${candidate.id}/approve`,
    });
    expect(reapprove.statusCode).toBe(409);

    const rejectApproved = await app.inject({
      method: "POST",
      url: `/api/memory/${candidate.id}/reject`,
      payload: {
        rejectionReason: "inaccurate",
      },
    });
    expect(rejectApproved.statusCode).toBe(409);

    const secondCandidate = await MemoryItemModel.create({
      organizationId,
      scopeType: "user",
      scopeId: ownerUser.id,
      kind: "preference",
      status: "candidate",
      content: "Fresh candidate",
      createdBy: ownerUser.id,
      policyFlags: [],
    });

    const supersedeCandidate = await app.inject({
      method: "POST",
      url: `/api/memory/${secondCandidate.id}/supersede`,
      payload: {
        content: "Supersede requires approved source",
      },
    });
    expect(supersedeCandidate.statusCode).toBe(409);

    const archiveCandidate = await app.inject({
      method: "POST",
      url: `/api/memory/${secondCandidate.id}/archive`,
    });
    expect(archiveCandidate.statusCode).toBe(200);
    expect(archiveCandidate.json().status).toBe("archived");

    const archiveAgain = await app.inject({
      method: "POST",
      url: `/api/memory/${secondCandidate.id}/archive`,
    });
    expect(archiveAgain.statusCode).toBe(409);

    const unarchiveCandidate = await app.inject({
      method: "POST",
      url: `/api/memory/${candidate.id}/unarchive`,
    });
    expect(unarchiveCandidate.statusCode).toBe(409);
  });
});
