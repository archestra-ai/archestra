// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

//
// End-to-end deployed-stack test of auto-sync-permissions for a GitHub connector,
// against a WireMock-stubbed GitHub API. It exercises the real HTTP stack:
// content-sync ACL ownership (create fail-closed) -> the runtime-isolated
// permission-sync pass (resolves the repo's collaborator audience and tags the
// document ACL) -> the runType-filtered runs API -> revoke upstream -> the pass
// fail-closes the ACL (no content change).
//
// The upstream GitHub audience is served by helm/e2e-tests/mappings/
// github-permission-sync.json; the "revoke" step flips a WireMock scenario.
import type { APIRequestContext } from "@playwright/test";
import { WIREMOCK_BASE_URL, WIREMOCK_INTERNAL_URL } from "../consts";
import { expect, test } from "./api-fixtures";

const OWNER = "test-org";
const REPO = "private-repo";
const SOURCE_ID = `${REPO}#1`;
const COLLAB_EMAIL = "alice@example.com";
const COLLAB_SCENARIO = "github-collaborators";
// A cron that will not fire during the test, so the only permission passes are
// the ones this test triggers (deterministic).
const NEVER_CRON = "0 0 1 1 *";

async function setWiremockScenarioState(
  request: APIRequestContext,
  scenario: string,
  state: string,
) {
  const res = await request.put(
    `${WIREMOCK_BASE_URL}/__admin/scenarios/${scenario}/state`,
    { data: { state } },
  );
  expect(res.ok()).toBe(true);
}

test.describe("knowledge base auto-sync-permissions (GitHub)", () => {
  let connectorId: string;
  let knowledgeBaseId: string;

  test.afterAll(async ({ makeApiRequest, request }) => {
    // Restore the schedule and clean up.
    await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/knowledge-settings",
      data: { permissionSyncSchedule: null },
      ignoreStatusCheck: true,
    });
    if (connectorId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/connectors/${connectorId}`,
        ignoreStatusCheck: true,
      });
    }
    if (knowledgeBaseId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/knowledge-bases/${knowledgeBaseId}`,
        ignoreStatusCheck: true,
      });
    }
    await request.post(`${WIREMOCK_BASE_URL}/__admin/scenarios/reset`);
  });

  test("permission sync tags the document from the repo audience, then fail-closes on revoke", async ({
    makeApiRequest,
    request,
  }) => {
    // Deterministic scheduler + a fresh collaborator scenario (grants alice).
    await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/knowledge-settings",
      data: { permissionSyncSchedule: NEVER_CRON },
    });
    await request.post(`${WIREMOCK_BASE_URL}/__admin/scenarios/reset`);

    // A knowledge base + a GitHub auto-sync-permissions connector pointed at the
    // in-cluster WireMock (backend -> wiremock uses the internal URL).
    const kb = await (
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/knowledge-bases",
        data: { name: "Permission Sync KB" },
      })
    ).json();
    knowledgeBaseId = kb.id;

    const connector = await (
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/connectors",
        data: {
          name: "GitHub auto-sync",
          knowledgeBaseIds: [knowledgeBaseId],
          connectorType: "github",
          visibility: "auto-sync-permissions",
          teamIds: [],
          config: {
            type: "github",
            githubUrl: `${WIREMOCK_INTERNAL_URL}/github`,
            owner: OWNER,
            repos: [REPO],
            authMethod: "pat",
          },
          credentials: { apiToken: "gh-token" },
        },
      })
    ).json();
    connectorId = connector.id;
    expect(connector.visibility).toBe("auto-sync-permissions");

    const docAcl = async (): Promise<string[] | null> => {
      const res = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/connectors/${connectorId}/documents?limit=10`,
      });
      const doc = (await res.json()).data?.find(
        (d: { sourceId: string }) => d.sourceId === SOURCE_ID,
      );
      return doc ? doc.acl : null;
    };

    // Trigger a permission sync, retrying while one is already running (409) so
    // the run we then wait on starts after any scenario change.
    const triggerPermissionSync = async () => {
      await expect
        .poll(
          async () => {
            const res = await makeApiRequest({
              request,
              method: "post",
              urlSuffix: `/api/connectors/${connectorId}/permission-sync`,
              ignoreStatusCheck: true,
            });
            return res.status();
          },
          { timeout: 60_000 },
        )
        .toBe(200);
    };

    // ---- Content sync ingests the issue; content-sync fail-closes new docs ----
    // A scheduled sync may already be running for a freshly-created connector
    // (409); either way the document gets ingested, so tolerate it and poll.
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/connectors/${connectorId}/sync`,
      ignoreStatusCheck: true,
    });
    await expect.poll(docAcl, { timeout: 60_000 }).toEqual([]);

    // ---- Permission sync tags the document with the collaborator's ACL ----
    await triggerPermissionSync();
    await expect
      .poll(docAcl, { timeout: 60_000 })
      .toEqual([`user_email:${COLLAB_EMAIL}`]);

    // A permission run is recorded and runType-filterable.
    const runs = await (
      await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/connectors/${connectorId}/runs?runType=permission&limit=5`,
      })
    ).json();
    expect(runs.data.length).toBeGreaterThan(0);
    expect(
      runs.data.every((r: { runType: string }) => r.runType === "permission"),
    ).toBe(true);

    // ---- Revoke access upstream; the next pass fail-closes the ACL ----
    await setWiremockScenarioState(request, COLLAB_SCENARIO, "Revoked");
    await triggerPermissionSync();
    await expect.poll(docAcl, { timeout: 60_000 }).toEqual([]);
  });
});
