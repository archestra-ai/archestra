import { type HttpHandler, HttpResponse, http, type JsonBodyType } from "msw";
import {
  adminPermissionsSeed,
  betterAuthOrgSeed,
  sessionSeed,
} from "./data/auth";
import { catalogSeed } from "./data/catalog";
import { configSeed, healthSeed, publicConfigSeed } from "./data/config";
import {
  appearanceSettingsSeed,
  organizationSeed,
  teamsSeed,
} from "./data/organization";
import { installedServersSeed } from "./data/servers";

// Register each endpoint twice: absolute URL for SSR (Next.js server
// components fetch the backend origin directly) and relative URL for the
// browser (served via Next.js rewrites). MSW path-to-regexp does not accept
// `*/...` host wildcards.
const BACKEND_ORIGIN =
  process.env.ARCHESTRA_INTERNAL_API_BASE_URL || "http://localhost:9000";

function getJson(path: string, body: JsonBodyType): HttpHandler[] {
  return [
    http.get(`${BACKEND_ORIGIN}${path}`, () => HttpResponse.json(body)),
    http.get(path, () => HttpResponse.json(body)),
  ];
}

export const handlers: HttpHandler[] = [
  ...getJson("/api/auth/get-session", sessionSeed),
  ...getJson("/api/auth/default-credentials-status", { enabled: false }),
  ...getJson("/api/auth/organization/list", []),
  ...getJson("/api/auth/organization/get-full-organization", betterAuthOrgSeed),
  ...getJson("/api/user/permissions", adminPermissionsSeed),
  ...getJson("/api/config", configSeed),
  ...getJson("/api/config/public", publicConfigSeed),
  ...getJson("/health", healthSeed),
  ...getJson("/api/organization", organizationSeed),
  ...getJson("/api/organization/appearance-settings", appearanceSettingsSeed),
  ...getJson("/api/organization/mcp-preset-entries", []),
  ...getJson("/api/teams", teamsSeed),
  ...getJson("/api/internal_mcp_catalog", catalogSeed),
  ...getJson("/api/internal_mcp_catalog/labels/keys", []),
  ...getJson("/api/mcp_server", installedServersSeed),
  ...getJson("/api/secrets/type", { type: "DB", meta: {} }),
  ...getJson("/api/k8s/image-pull-secrets", []),

  http.get(
    `${BACKEND_ORIGIN}/api/internal_mcp_catalog/:catalogId/children`,
    () => HttpResponse.json([]),
  ),
  http.get("/api/internal_mcp_catalog/:catalogId/children", () =>
    HttpResponse.json([]),
  ),
];
