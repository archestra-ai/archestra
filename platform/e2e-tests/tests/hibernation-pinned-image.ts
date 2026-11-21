// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { type APIRequestContext, expect } from "@playwright/test";
import type { TestFixtures } from "./api-fixtures";

/**
 * The MCP base image this deployment runs, for catalog items that must pin it
 * as their own `localConfig.dockerImage`.
 *
 * Specs that break a Deployment's image on purpose need this. The runtime
 * moves a server on the default base image back to the configured base image
 * on adoption and before every wake, so an image injected into such a
 * Deployment is undone before the pod it should break is ever scheduled. A
 * catalog item that names its own image is never moved. Pinning the same image
 * the default would resolve to keeps the pod identical and leaves the injected
 * image in place.
 */
export async function readMcpServerBaseImage(params: {
  request: APIRequestContext;
  makeApiRequest: TestFixtures["makeApiRequest"];
}): Promise<string> {
  const response = await params.makeApiRequest({
    request: params.request,
    method: "get",
    urlSuffix: "/api/config",
  });
  const image: unknown = (await response.json()).features?.mcpServerBaseImage;
  expect(
    typeof image === "string" && image.length > 0,
    "/api/config must report the MCP base image",
  ).toBe(true);
  return image as string;
}
