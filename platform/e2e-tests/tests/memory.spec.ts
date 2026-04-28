import { E2eTestId } from "@shared";
import { expect, test } from "./api-fixtures";

function makeMarker(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

test.describe("Memory API lifecycle", () => {
  test("api lifecycle supports create approve reject archive unarchive delete", {
    tag: ["@memory"],
  }, async ({ request, makeApiRequest, getActiveOrganizationId }) => {
    const organizationId = await getActiveOrganizationId(request);

    const createdAResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/memory",
      data: {
        scopeType: "organization",
        scopeId: organizationId,
        kind: "org_fact",
        content: makeMarker("memory-api-a"),
      },
    });
    const createdA = await createdAResponse.json();

    const approvedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/memory/${createdA.id}/approve`,
      data: {},
    });
    const approved = await approvedResponse.json();
    expect(approved.status).toBe("approved");

    const archivedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/memory/${createdA.id}/archive`,
      data: {},
    });
    const archived = await archivedResponse.json();
    expect(archived.status).toBe("archived");

    const restoredResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/memory/${createdA.id}/unarchive`,
      data: {},
    });
    const restored = await restoredResponse.json();
    expect(restored.status).toBe("candidate");

    const deletedAResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/memory/${createdA.id}`,
    });
    const deletedA = await deletedAResponse.json();
    expect(deletedA).toEqual({ success: true });

    const createdBResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/memory",
      data: {
        scopeType: "organization",
        scopeId: organizationId,
        kind: "org_fact",
        content: makeMarker("memory-api-b"),
      },
    });
    const createdB = await createdBResponse.json();

    const rejectedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/memory/${createdB.id}/reject`,
      data: {
        rejectionReason: "sensitive",
        rejectionComment: "policy",
      },
    });
    const rejected = await rejectedResponse.json();
    expect(rejected.status).toBe("rejected");

    const archivedRejectedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/memory/${createdB.id}/archive`,
      data: {},
    });
    const archivedRejected = await archivedRejectedResponse.json();
    expect(archivedRejected.status).toBe("archived");

    const deletedBResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/memory/${createdB.id}`,
    });
    const deletedB = await deletedBResponse.json();
    expect(deletedB).toEqual({ success: true });
  });

  test("api enforces scope isolation and RBAC for non-admin users", {
    tag: ["@memory"],
  }, async ({
    request,
    memberRequest,
    makeApiRequest,
    getActiveOrganizationId,
  }) => {
    const organizationId = await getActiveOrganizationId(request);

    const createdResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/memory",
      data: {
        scopeType: "organization",
        scopeId: organizationId,
        kind: "org_fact",
        content: makeMarker("memory-rbac"),
      },
    });
    const created = await createdResponse.json();

    const memberGetResponse = await makeApiRequest({
      request: memberRequest,
      method: "get",
      urlSuffix: `/api/memory/${created.id}`,
      ignoreStatusCheck: true,
    });
    expect([403, 404]).toContain(memberGetResponse.status());

    const memberApproveResponse = await makeApiRequest({
      request: memberRequest,
      method: "post",
      urlSuffix: `/api/memory/${created.id}/approve`,
      data: {},
      ignoreStatusCheck: true,
    });
    expect([403, 409]).toContain(memberApproveResponse.status());

    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/memory/${created.id}`,
      ignoreStatusCheck: true,
    });
  });
});

test.describe("Memory UI workflows", () => {
  test("settings memory enforces stage-13 final action matrix", {
    tag: ["@memory"],
  }, async ({ page, request, makeApiRequest, getActiveOrganizationId }) => {
    test.setTimeout(120_000);

    const organizationId = await getActiveOrganizationId(request);
    const approvedMarker = makeMarker("memory-ui-approved");
    const rejectedMarker = makeMarker("memory-ui-rejected");

    const createdApprovedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/memory",
      data: {
        scopeType: "organization",
        scopeId: organizationId,
        kind: "org_fact",
        content: approvedMarker,
      },
    });
    const createdApproved = await createdApprovedResponse.json();

    const createdRejectedResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/memory",
      data: {
        scopeType: "organization",
        scopeId: organizationId,
        kind: "org_fact",
        content: rejectedMarker,
      },
    });
    const createdRejected = await createdRejectedResponse.json();
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/memory/${createdRejected.id}/reject`,
      data: {
        rejectionReason: "sensitive",
      },
    });

    await page.goto("http://localhost:3000/settings/memory");
    await expect(page.getByTestId(E2eTestId.MemoryTable)).toBeVisible({
      timeout: 30_000,
    });

    const searchInput = page.getByPlaceholder("Search memory items by content");
    const getTargetRow = (marker: string) =>
      page.getByRole("row").filter({ hasText: marker }).first();

    await searchInput.fill(approvedMarker);
    await expect(getTargetRow(approvedMarker)).toBeVisible({ timeout: 30_000 });

    await getTargetRow(approvedMarker).click();
    await expect(page.getByRole("heading", { name: "Actions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    await page.getByRole("button", { name: "Approve" }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: "Approved" }).click();
    await searchInput.fill(approvedMarker);
    await expect(getTargetRow(approvedMarker)).toBeVisible({ timeout: 30_000 });

    await getTargetRow(approvedMarker).click();
    await expect(
      page.getByRole("button", { name: "Re-propose" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await page.getByRole("button", { name: "Reject" }).click();

    const rejectButton = page.getByTestId(E2eTestId.MemoryRejectButton);
    await expect(rejectButton).toBeDisabled();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Sensitive" }).click();
    await expect(rejectButton).toBeEnabled();
    await page.getByRole("button", { name: "Cancel" }).click();
    await getTargetRow(approvedMarker).click();
    await page.getByRole("button", { name: "Archive" }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: "Rejected" }).click();
    await expect(page.getByRole("tab", { name: "Rejected" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await searchInput.fill(rejectedMarker);
    await expect(getTargetRow(rejectedMarker)).toBeVisible({ timeout: 30_000 });

    await getTargetRow(rejectedMarker).click();
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await page.getByRole("button", { name: "Archive" }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: "Archived" }).click();
    await expect(page.getByRole("tab", { name: "Archived" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await searchInput.fill(rejectedMarker);
    await expect(getTargetRow(rejectedMarker)).toBeVisible({ timeout: 30_000 });

    await page.getByText(rejectedMarker).first().click();
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Re-propose" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
    await page.keyboard.press("Escape");

    await getTargetRow(rejectedMarker)
      .getByRole("checkbox", { name: "Select row" })
      .click();
    await expect(page.getByText("1 selected")).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);

    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/memory/${createdApproved.id}`,
      ignoreStatusCheck: true,
    });
    await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/memory/${createdRejected.id}`,
      ignoreStatusCheck: true,
    });
  });
});
