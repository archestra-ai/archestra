import { HttpResponse, http } from "msw";

export const origin = "http://localhost:9000";

export const account = {
  id: "account-1",
  organizationId: "org-1",
  name: "Automation worker",
  icon: null,
  role: "member",
  teamId: null,
  disabled: false,
  tokenCount: 1,
  activeTokenCount: 1,
  soonestExpiryAt: null,
  federatedCredentialCount: 0,
  lastUsedAt: null,
  labels: [] as { key: string; value: string }[],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  createdBy: null,
};

/** The endpoints every service account screen reads. */
export const baseHandlers = [
  http.get(`${origin}/api/service-accounts`, () =>
    HttpResponse.json([account]),
  ),
  http.get(`${origin}/api/service-accounts/:id`, () =>
    HttpResponse.json({ ...account, tokens: [] }),
  ),
  http.get(`${origin}/api/service-accounts/:id/federated-credentials`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${origin}/api/service-accounts/labels/keys`, () =>
    HttpResponse.json([]),
  ),
  http.get(`${origin}/api/roles`, () => HttpResponse.json([])),
  http.get(`${origin}/api/teams`, () =>
    HttpResponse.json({
      data: [{ id: "team-platform", name: "Platform" }],
      pagination: {
        currentPage: 1,
        limit: 100,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    }),
  ),
  http.get(`${origin}/api/resource-permissions/serviceAccount/:scope`, () =>
    HttpResponse.json({
      resource: "serviceAccount",
      scope: account.id,
      name: account.name,
      ownerId: null,
      revision: 1,
      grants: [],
      inheritedGrants: [],
      effectiveActions: ["read", "update", "manage-permissions"],
      canShareOrganizationWide: true,
      actorSubjects: [],
    }),
  ),
];
