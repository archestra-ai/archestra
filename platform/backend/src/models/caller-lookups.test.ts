import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import { requestScope } from "@/auth/request-scope";
import { describe, expect, test } from "@/test";
import MemberModel from "./member";
import ResourcePermissionSubjectModel from "./resource-permission-subject";
import RoleCompositionModel from "./role-composition";
import TeamModel from "./team";
import UserModel from "./user";

// Each request runs in its own async context, as Fastify's handlers do.
const inRequest = <T>(memoize: boolean, body: () => Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      requestScope.enter({ memoize });
      body().then(resolve, reject);
    });
  });

const countStatements = async <T>(body: () => Promise<T>) => {
  const query = vi.spyOn(PGlite.prototype, "query");
  try {
    const result = await body();
    return { result, statements: query.mock.calls.length };
  } finally {
    query.mockRestore();
  }
};

describe("caller lookups shared by a read request", () => {
  test("a read request reads the member row once and hands out copies", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const read = await inRequest(true, () =>
      countStatements(async () => {
        const first = await MemberModel.getByUserId(user.id, org.id);
        if (first) first.role = "changed by a caller";
        return [first, await MemberModel.getByUserId(user.id, org.id)];
      }),
    );
    expect(read.statements).toBe(1);
    expect(read.result[1]?.role).toBe("member");
    const write = await inRequest(false, () =>
      countStatements(async () => {
        await MemberModel.getByUserId(user.id, org.id);
        await MemberModel.getByUserId(user.id, org.id);
      }),
    );
    expect(write.statements).toBe(2);
  });

  test("a read request builds a caller's role sources once", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const params = { userId: user.id, organizationId: org.id };
    const expected = await RoleCompositionModel.getUserSources(params);
    const read = await inRequest(true, () =>
      countStatements(async () => {
        const [first, second] = await Promise.all([
          RoleCompositionModel.getUserSources(params),
          RoleCompositionModel.getUserSources(params),
        ]);
        first.length = 0;
        return [second, await RoleCompositionModel.getUserSources(params)];
      }),
    );
    const write = await inRequest(false, () =>
      countStatements(async () => [
        await RoleCompositionModel.getUserSources(params),
        await RoleCompositionModel.getUserSources(params),
      ]),
    );
    expect(read.result).toEqual([expected, expected]);
    expect(write.result).toEqual([expected, expected]);
    expect(write.statements).toBe(2 * read.statements);
  });

  test("a write request sees team membership changes between access checks", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, user.id);
    const params = { userId: user.id, organizationId: org.id };
    const { before, after } = await inRequest(false, async () => {
      const before =
        await ResourcePermissionSubjectModel.resolvePrincipal(params);
      await makeTeamMember(team.id, user.id);
      const after =
        await ResourcePermissionSubjectModel.resolvePrincipal(params);
      return { before, after };
    });
    expect(before.subjects).not.toContainEqual({ type: "team", id: team.id });
    expect(after.subjects).toContainEqual({ type: "team", id: team.id });
  });

  test("one statement gives a caller's role-source teams and every team their grants can name", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    await makeMember(user.id, other.id);
    const root = await makeTeam(org.id, user.id, { name: "Root" });
    const child = await makeTeam(org.id, user.id, {
      name: "Child",
      parentId: root.id,
    });
    const leaf = await makeTeam(org.id, user.id, {
      name: "Leaf",
      parentId: child.id,
    });
    const unrelated = await makeTeam(org.id, user.id, { name: "Unrelated" });
    const elsewhere = await makeTeam(other.id, user.id, { name: "Elsewhere" });
    await makeTeamMember(leaf.id, user.id);
    await makeTeamMember(elsewhere.id, user.id);
    const params = { userId: user.id, organizationId: org.id };
    const { result, statements } = await inRequest(true, () =>
      countStatements(async () => {
        await TeamModel.getUserTeamContext(params);
        return TeamModel.getUserTeamContext(params);
      }),
    );
    expect(statements).toBe(1);
    expect(result.subjectTeamIds.sort()).toEqual(
      (await TeamModel.getUserTeamIds(user.id)).sort(),
    );
    expect(result.subjectTeamIds).not.toContain(unrelated.id);
    expect(result.sourceTeams.map((team) => team.name).sort()).toEqual([
      "Child",
      "Leaf",
      "Root",
    ]);
  });

  test("the session user's first membership is the member row of its organization", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const first = await makeOrganization();
    const second = await makeOrganization();
    const user = await makeUser();
    const joined = new Date();
    await makeMember(user.id, first.id, { role: "admin", createdAt: joined });
    // A later join, not just a later call: two calls can land in one
    // millisecond, and the tie would fall to the random member id.
    await makeMember(user.id, second.id, {
      role: "member",
      createdAt: new Date(joined.getTime() + 1000),
    });
    const expected = await MemberModel.getByUserId(user.id, first.id);
    const { result, statements } = await inRequest(true, () =>
      countStatements(async () => {
        const sessionUser = await UserModel.getById(user.id);
        const member = await MemberModel.getByUserId(
          user.id,
          sessionUser?.organizationId ?? "",
        );
        return { sessionUser, member };
      }),
    );
    expect(statements).toBe(1);
    expect(result.sessionUser?.organizationId).toBe(first.id);
    expect(result.sessionUser).not.toHaveProperty("membership");
    expect(result.member).toEqual(expected);
  });
});
