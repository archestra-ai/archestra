import {
    type APIRequestContext,
    expect,
    test as setup,
} from "@playwright/test";
import {
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    BASIC_USER_EMAIL,
    BASIC_USER_PASSWORD,
    BASIC_USER_ROLE_NAME,
    basicUserAuthFile,
    UI_BASE_URL,
} from "./consts";
import {
    createInvitation,
    signInUser,
    signOut,
    signUpWithInvitation,
    sleep,
    userExists,
} from "./auth.setup.helpers";
import { expectAuthenticated } from "./utils";

const BASIC_USER_PERMISSION = {
    agent: ["read"],
    chat: ["read"],
    llmProviderApiKey: ["read"],
    llmModel: ["read"],
} as const;

async function findCustomRole(
    request: APIRequestContext,
    name: string,
): Promise<{ id: string; role: string } | null> {
    const response = await request.get(
        `${UI_BASE_URL}/api/roles?name=${encodeURIComponent(name)}`,
        { headers: { Origin: UI_BASE_URL } },
    );
    if (!response.ok()) {
        return null;
    }
    const body = await response.json();
    const match = body?.data?.find(
        (role: { name: string; id: string; role: string }) => role.name === name,
    );
    if (!match?.id || !match?.role) {
        return null;
    }
    return { id: match.id, role: match.role };
}

async function ensureBasicUserRole(
    request: APIRequestContext,
): Promise<string> {
    const description = "Slim role used by chat-permissions e2e regression test";
    const existing = await findCustomRole(request, BASIC_USER_ROLE_NAME);

    if (existing) {
        const updateResponse = await request.put(
            `${UI_BASE_URL}/api/roles/${existing.id}`,
            {
                data: {
                    name: BASIC_USER_ROLE_NAME,
                    description,
                    permission: BASIC_USER_PERMISSION,
                },
                headers: { Origin: UI_BASE_URL },
            },
        );
        if (!updateResponse.ok()) {
            const errorText = await updateResponse.text();
            throw new Error(
                `Failed to refresh basic-user role permissions (${updateResponse.status()}): ${errorText}`,
            );
        }
        return existing.role;
    }

    const response = await request.post(`${UI_BASE_URL}/api/roles`, {
        data: {
            name: BASIC_USER_ROLE_NAME,
            description,
            permission: BASIC_USER_PERMISSION,
        },
        headers: { Origin: UI_BASE_URL },
    });

    if (!response.ok()) {
        const errorText = await response.text();
        throw new Error(
            `Failed to create basic-user custom role (${response.status()}): ${errorText}`,
        );
    }

    const created = await response.json();
    if (!created?.role) {
        throw new Error(
            `Basic-user role create response missing 'role' field: ${JSON.stringify(created)}`,
        );
    }
    return created.role;
}

setup("authenticate as basic-user (custom role)", async ({ page }) => {
    const basicUserExists = await userExists(
        page.request,
        BASIC_USER_EMAIL,
        BASIC_USER_PASSWORD,
    );

    await sleep(100);
    const adminSignedIn = await signInUser(
        page.request,
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
    );
    expect(adminSignedIn, "Admin sign-in failed for basic-user setup").toBe(true);

    await page.goto(`${UI_BASE_URL}/chat`);
    await page.waitForLoadState("domcontentloaded");

    const basicUserRoleIdentifier = await ensureBasicUserRole(page.request);

    if (!basicUserExists) {
        const invitationId = await createInvitation(
            page.request,
            BASIC_USER_EMAIL,
            basicUserRoleIdentifier,
        );

        await signOut(page.request);

        await signUpWithInvitation(
            page.request,
            BASIC_USER_EMAIL,
            BASIC_USER_PASSWORD,
            invitationId,
        );
    } else {
        await signOut(page.request);

        const signedIn = await signInUser(
            page.request,
            BASIC_USER_EMAIL,
            BASIC_USER_PASSWORD,
        );
        expect(signedIn, "Basic-user sign-in failed").toBe(true);
    }

    await page.goto(`${UI_BASE_URL}/chat`);
    await page.waitForLoadState("domcontentloaded");

    await expectAuthenticated(page);

    await page.context().storageState({ path: basicUserAuthFile });
});