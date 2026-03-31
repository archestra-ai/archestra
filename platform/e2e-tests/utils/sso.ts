// biome-ignore-all lint/suspicious/noConsole: we use console.log for retry logging in this file
import type { Page } from "@playwright/test";
import {
  KC_MEMBER_USER,
  KC_TEST_USER,
  KEYCLOAK_EXTERNAL_URL,
  KEYCLOAK_OIDC,
  KEYCLOAK_REALM,
  UI_BASE_URL,
} from "../consts";
import { clickButton } from "./dialogs";

export async function getKeycloakJwt(): Promise<string> {
  return getKeycloakJwtForUser(KC_TEST_USER);
}

export async function getAdminKeycloakJwt(): Promise<string> {
  return getKeycloakJwtForUser(KC_TEST_USER);
}

export async function getMemberKeycloakJwt(): Promise<string> {
  return getKeycloakJwtForUser(KC_MEMBER_USER);
}

export async function loginViaKeycloak(ssoPage: Page): Promise<boolean> {
  await ssoPage.waitForURL(/.*localhost:30081.*|.*keycloak.*/, {
    timeout: 30000,
  });
  await ssoPage.waitForLoadState("domcontentloaded");

  const usernameField = ssoPage.getByLabel("Username or email");
  await usernameField.waitFor({ state: "visible", timeout: 10000 });
  await usernameField.fill(KC_TEST_USER.username);

  const passwordField = ssoPage.getByRole("textbox", { name: "Password" });
  await passwordField.waitFor({ state: "visible", timeout: 10000 });
  await passwordField.fill(KC_TEST_USER.password);

  await clickButton({ page: ssoPage, options: { name: "Sign In" } });

  await ssoPage.waitForURL(`${UI_BASE_URL}/**`, { timeout: 60000 });
  await ssoPage.waitForLoadState("domcontentloaded");

  const finalUrl = ssoPage.url();
  const loginSucceeded = !finalUrl.includes("/auth/sign-in");

  if (!loginSucceeded) {
    const errorToast = ssoPage.locator('[role="alert"]').first();
    const errorText = await errorToast.textContent().catch(() => null);
    if (errorText && !errorText.includes("Default Admin Credentials Enabled")) {
      console.log(`SSO login failed with error: ${errorText}`);
    }
  }

  return loginSucceeded;
}

export async function fetchKeycloakSamlMetadata(): Promise<string> {
  const response = await fetchWithRetry(
    `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/saml/descriptor`,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Keycloak SAML metadata: ${response.status}`,
    );
  }
  const metadata = await response.text();
  return metadata.replace(
    'WantAuthnRequestsSigned="true"',
    'WantAuthnRequestsSigned="false"',
  );
}

export function extractCertFromMetadata(metadata: string): string {
  const match = metadata.match(
    /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/,
  );
  if (!match) {
    throw new Error("Could not extract certificate from IdP metadata");
  }
  return match[1];
}

async function getKeycloakJwtForUser(params: {
  username: string;
  password: string;
}): Promise<string> {
  const tokenUrl = `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`;

  const response = await fetchWithRetry(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: KEYCLOAK_OIDC.clientId,
      client_secret: KEYCLOAK_OIDC.clientSecret,
      username: params.username,
      password: params.password,
      scope: "openid",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Keycloak token request failed: ${response.status} ${text}`,
    );
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  maxRetries = 5,
  initialDelayMs = 2000,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = initialDelayMs * 2 ** attempt;
        console.log(
          `fetch ${url} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error instanceof Error ? error.message : error}. Retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${url}`);
}
