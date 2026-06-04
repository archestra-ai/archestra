"use client";

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { EnvironmentsSection } from "../../mcp/registry/_parts/environments-section";
import { useSetSettingsAction } from "../layout";

export default function EnvironmentsPageClient() {
  const setActionButton = useSetSettingsAction();
  const { data: canEdit } = useHasPermissions({
    environment: ["admin"],
  });
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ environment: ["admin"] }}
        onClick={() => setCreateOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Add environment
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [setActionButton]);

  return (
    <EnvironmentsSection
      canEdit={canEdit ?? false}
      createOpen={createOpen}
      onCreateOpenChange={setCreateOpen}
    />
  );
}
