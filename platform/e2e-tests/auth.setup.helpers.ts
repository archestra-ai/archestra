import type { APIRequestContext } from "@playwright/test";
import { UI_BASE_URL } from "./consts";

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sign in a user via API and return true if successful
 * Handles rate limiting (429) with exponential backoff retry
 */
export async function signInUser(
    request: APIRequestContext,
    email: string,
    password: string,
): Promise<boolean> {
    const maxRetries = 3;
    let delay = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await request.post(
            `${UI_BASE_URL}/api/auth/sign-in/email`,
            {
                data: { email, password },
                headers: {
                    Origin: UI_BASE_URL,
                },
            },
        );

        if (response.ok()) {
            return true;
        }

        if (response.status() === 429 && attempt < maxRetries) {
            await sleep(delay);
            delay *= 2;
            continue;
        }

        return false;
    }

    return false;
}

/**
 * Sign out the current user
 */
export async function signOut(request: APIRequestContext): Promise<void> {
    await request.post(`${UI_BASE_URL}/api/auth/sign-out`);
}

/**
 * Get the active organization ID from the current session
 */
async function getActiveOrganizationId(
    request: APIRequestContext,
): Promise<string | null> {
    const response = await request.get(`${UI_BASE_URL}/api/auth/get-session`);
    if (!response.ok()) {
        return null;
    }
    const data = await response.json();
    return data?.session?.activeOrganizationId ?? null;
}

/**
 * Get existing invitation for a user
 */
async function getExistingInvitation(
    request: APIRequestContext,
    email: string,
    organizationId: string,
): Promise<string | null> {
    const response = await request.get(
        `${UI_BASE_URL}/api/auth/organization/list-invitations?organizationId=${organizationId}`,
        {
            headers: { Origin: UI_BASE_URL },
        },
    );
    if (!response.ok()) {
        return null;
    }
    const invitations = await response.json();
    const existing = invitations?.find(
        (inv: { email: string; status: string }) =>
            inv.email === email && inv.status === "pending",
    );
    return existing?.id ?? null;
}

/**
 * Create an invitation for a new user (must be called as admin)
 * If user is already invited, returns the existing invitation ID
 * @returns invitation ID or throws error with details
 */
export async function createInvitation(
    request: APIRequestContext,
    email: string,
    role: string,
): Promise<string> {
    const organizationId = await getActiveOrganizationId(request);
    if (!organizationId) {
        throw new Error(
            "Failed to get organization ID - admin may not be logged in",
        );
    }

    const existingInvitationId = await getExistingInvitation(
        request,
        email,
        organizationId,
    );
    if (existingInvitationId) {
        return existingInvitationId;
    }

    const response = await request.post(
        `${UI_BASE_URL}/api/auth/organization/invite-member`,
        {
            data: { email, role, organizationId },
            headers: {
                Origin: UI_BASE_URL,
            },
        },
    );

    if (!response.ok()) {
        const errorText = await response.text();
        if (errorText.includes("USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION")) {
            const existingInvitationId = await getExistingInvitation(
                request,
                email,
                organizationId,
            );

            if (existingInvitationId) {
                return existingInvitationId;
            }
        }

        throw new Error(
            `Invitation API failed (${response.status()}): ${errorText}`,
        );
    }

    const data = await response.json();
    return data.id;
}

/**
 * Sign up a new user with an invitation
 * The invitation ID is passed via callbackURL which better-auth uses to auto-accept
 * @returns true if successful, throws error with details on failure
 */
export async function signUpWithInvitation(
    request: APIRequestContext,
    email: string,
    password: string,
    invitationId: string,
): Promise<boolean> {
    const callbackURL = `${UI_BASE_URL}/auth/sign-up-with-invitation?invitationId=${invitationId}&email=${encodeURIComponent(email)}`;

    const signUpResponse = await request.post(
        `${UI_BASE_URL}/api/auth/sign-up/email`,
        {
            data: {
                email,
                password,
                name: email.split("@")[0],
                callbackURL,
            },
            headers: {
                Origin: UI_BASE_URL,
            },
        },
    );

    if (!signUpResponse.ok()) {
        const errorText = await signUpResponse.text();
        throw new Error(
            `Sign-up failed (${signUpResponse.status()}): ${errorText}\nCallbackURL: ${callbackURL}`,
        );
    }

    return true;
}

/**
 * Check if a user already exists by trying to sign in
 */
export async function userExists(
    request: APIRequestContext,
    email: string,
    password: string,
): Promise<boolean> {
    const signedIn = await signInUser(request, email, password);
    if (signedIn) {
        await signOut(request);
    }
    return signedIn;
}