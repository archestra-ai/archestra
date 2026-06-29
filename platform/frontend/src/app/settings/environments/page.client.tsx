"use client";

import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { setEnvironmentCreateParam } from "../../mcp/registry/_parts/environment-edit-link";
import { EnvironmentsSection } from "../../mcp/registry/_parts/environments-section";
import { useSetSettingsAction } from "../layout";

export default function EnvironmentsPageClient() {
  const setActionButton = useSetSettingsAction();
  const { data: canEdit } = useHasPermissions({
    environment: ["admin"],
  });
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Keep the latest search in a ref so openCreate stays referentially stable —
  // otherwise the action-button effect re-registers on every URL change.
  const searchRef = useRef(searchParams);
  searchRef.current = searchParams;

  const openCreate = useCallback(() => {
    const search = setEnvironmentCreateParam(searchRef.current.toString());
    router.replace(`${pathname}?${search}`, { scroll: false });
  }, [router, pathname]);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ environment: ["admin"] }}
        onClick={openCreate}
      >
        <Plus className="h-4 w-4" />
        Add environment
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [setActionButton, openCreate]);

  return <EnvironmentsSection canEdit={canEdit ?? false} />;
}
