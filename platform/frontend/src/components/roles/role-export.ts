import type { archestraApiTypes } from "@shared";

type Role = archestraApiTypes.GetRoleResponses["200"];

export function downloadRoleAsJson(role: Role) {
  const payload = {
    name: role.name,
    description: role.description ?? null,
    predefined: role.predefined,
    permission: role.permission,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `role-${role.name}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
