import {
  type archestraApiTypes,
  type PredefinedRoleName,
  roleDescriptions,
} from "@shared";
import { Shield } from "lucide-react";

type Role = archestraApiTypes.GetRoleResponses["200"];

interface PredefinedRolesProps {
  predefinedRoles: Role[];
}

export function PredefinedRoles({ predefinedRoles }: PredefinedRolesProps) {
  if (predefinedRoles.length === 0) {
    return null;
  }
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
        Predefined Roles
      </h3>
      <div className="space-y-3">
        {predefinedRoles.map((role) => {
          const description = roleDescriptions[role.name as PredefinedRoleName];
          return (
            <div
              key={role.id}
              className="flex items-center justify-between rounded-lg border bg-muted/30 p-4"
            >
              <div className="flex items-center gap-3">
                <Shield className="h-5 w-5 text-primary" />
                <div>
                  <h4 className="font-semibold capitalize">{role.name}</h4>
                  {description && (
                    <p className="text-xs text-muted-foreground">
                      {description}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
