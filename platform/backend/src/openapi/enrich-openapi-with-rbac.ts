import {
  permissionDescriptions,
  requiredEndpointPermissionsMap,
} from "@shared/access-control";

// === Exports ===

export function enrichOpenApiWithRbac<T extends OpenApiDocument>(spec: T): T {
  const clonedSpec = structuredClone(spec);

  for (const pathItem of Object.values(clonedSpec.paths ?? {})) {
    if (!pathItem) {
      continue;
    }

    for (const operation of getOperations(pathItem)) {
      const operationId = operation.operationId;
      if (!operationId) {
        continue;
      }

      const permissionKeys = flattenPermissions(
        requiredEndpointPermissionsMap[
          operationId as keyof typeof requiredEndpointPermissionsMap
        ],
      );
      if (permissionKeys.length === 0) {
        continue;
      }

      operation["x-required-permissions"] = {
        allOf: permissionKeys,
      };

      const permissionSection = [
        "Required RBAC permissions:",
        ...permissionKeys.map(
          (key) =>
            `- \`${key}\`: ${permissionDescriptions[key] ?? "No description available"}`,
        ),
      ].join("\n");

      operation.description = appendDescriptionSection(
        operation.description,
        permissionSection,
      );
    }
  }

  return clonedSpec;
}

// === Types ===

type OpenApiDocument = {
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, OpenApiPathItem | undefined>;
};

type OpenApiPathItem = Partial<
  Record<HttpMethod, OpenApiOperation | undefined>
>;

type OpenApiOperation = {
  operationId?: string;
  description?: string;
  "x-required-permissions"?: {
    allOf: string[];
  };
};

type HttpMethod =
  | "delete"
  | "get"
  | "head"
  | "options"
  | "patch"
  | "post"
  | "put"
  | "trace";

// === Internal helpers ===

function getOperations(pathItem: OpenApiPathItem): OpenApiOperation[] {
  return Object.entries(pathItem)
    .filter(([method]) => HTTP_METHODS.has(method as HttpMethod))
    .map(([, operation]) => operation)
    .filter(
      (operation): operation is OpenApiOperation =>
        operation !== undefined && operation !== null,
    );
}

function flattenPermissions(
  permissions: Record<string, string[]> | undefined,
): string[] {
  if (!permissions) {
    return [];
  }

  return Object.entries(permissions)
    .flatMap(([resource, actions]) =>
      [...actions].sort().map((action) => `${resource}:${action}`),
    )
    .sort();
}

function appendDescriptionSection(
  description: string | undefined,
  section: string,
): string {
  if (!description) {
    return section;
  }

  return `${description}\n\n${section}`;
}

const HTTP_METHODS = new Set<HttpMethod>([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);
