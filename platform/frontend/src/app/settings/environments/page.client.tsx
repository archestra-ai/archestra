"use client";

import { Plus, Settings2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import {
  setEnvironmentCreateParam,
  setEnvironmentDefaultsParam,
} from "../../mcp/registry/_parts/environment-edit-link";
import { EnvironmentsSection } from "../../mcp/registry/_parts/environments-section";
import { useSetSettingsAction } from "../layout";

export default function EnvironmentsPageClient() {
  const setActionButton = useSetSettingsAction();
  const { data: canEdit } = useHasPermissions({
    environment: ["update"],
  });
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // With no environments to choose from, every kind of resource can only land
  // in Default, so the settings behind the cog would be a column of dead
  // selects — the button only appears once there is a real choice to make.
  const { data: environmentList } = useEnvironments();
  const hasEnvironments = (environmentList?.environments.length ?? 0) > 0;
  // Keep the latest search in a ref so the openers stay referentially stable —
  // otherwise the action-button effect re-registers on every URL change.
  const searchRef = useRef(searchParams);
  searchRef.current = searchParams;

  const openCreate = useCallback(() => {
    const search = setEnvironmentCreateParam(searchRef.current.toString());
    router.replace(`${pathname}?${search}`, { scroll: false });
  }, [router, pathname]);

  const openResourceDefaults = useCallback(() => {
    const search = setEnvironmentDefaultsParam(searchRef.current.toString());
    router.replace(`${pathname}?${search}`, { scroll: false });
  }, [router, pathname]);

  useEffect(() => {
    setActionButton(
      <div className="flex items-center gap-2">
        {hasEnvironments ? (
          <PermissionButton
            permissions={{ environment: ["update"] }}
            variant="secondary"
            size="icon"
            aria-label="Where new resources land"
            tooltip="Where new resources land"
            onClick={openResourceDefaults}
          >
            <Settings2 className="h-4 w-4" />
          </PermissionButton>
        ) : null}
        <PermissionButton
          permissions={{ environment: ["create"] }}
          onClick={openCreate}
        >
          <Plus className="h-4 w-4" />
          Add environment
        </PermissionButton>
      </div>,
    );

    return () => setActionButton(null);
  }, [setActionButton, openCreate, openResourceDefaults, hasEnvironments]);

  return <EnvironmentsSection canEdit={canEdit ?? false} />;
}
