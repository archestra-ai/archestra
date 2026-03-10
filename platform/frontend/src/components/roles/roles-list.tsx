"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
  type PredefinedRoleName,
  roleDescriptions,
} from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Shield } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EnterpriseLicenseRequired } from "@/components/enterprise-license-required";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { useRolesPaginated } from "@/lib/role.query";
import { DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";

type RoleData = archestraApiTypes.GetRolesResponses["200"]["data"][number];

export function RolesList() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // URL-driven state
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFilter = searchParams.get("search") || "";
  const sortByFromUrl = searchParams.get("sortBy") as
    | "name"
    | "createdAt"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;

  const sortBy = sortByFromUrl || "createdAt";
  const sortDirection = sortDirectionFromUrl || "desc";

  const { data: rolesResponse, isPending } = useRolesPaginated({
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    search: searchFilter || undefined,
  });

  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Sync sorting state with URL params
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);

      const params = new URLSearchParams(searchParams.toString());
      if (newSorting.length > 0) {
        params.set("sortBy", newSorting[0].id);
        params.set("sortDirection", newSorting[0].desc ? "desc" : "asc");
      } else {
        params.delete("sortBy");
        params.delete("sortDirection");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [sorting, searchParams, router, pathname],
  );

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const roles = rolesResponse?.data || [];
  const pagination = rolesResponse?.pagination;

  const columns: ColumnDef<RoleData>[] = [
    {
      id: "name",
      accessorKey: "name",
      size: 200,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const role = row.original;
        return (
          <div className="flex items-center gap-2">
            {role.predefined && (
              <Shield className="h-4 w-4 text-primary shrink-0" />
            )}
            <span className="font-medium capitalize">{role.name}</span>
          </div>
        );
      },
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      size: 300,
      cell: ({ row }) => {
        const role = row.original;
        const description = role.predefined
          ? roleDescriptions[role.name as PredefinedRoleName] ||
            role.description
          : role.description;
        return (
          <span className="text-sm text-muted-foreground">
            {description || "-"}
          </span>
        );
      },
    },
    {
      id: "type",
      header: "Type",
      size: 120,
      cell: ({ row }) => {
        const role = row.original;
        return role.predefined ? (
          <Badge variant="secondary">Predefined</Badge>
        ) : (
          <Badge variant="outline">Custom</Badge>
        );
      },
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Created
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.createdAt })}
        </div>
      ),
    },
  ];

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title="Roles & Permissions"
        description={
          <p className="text-sm text-muted-foreground">
            View roles and their permissions.{" "}
            <a
              href={getDocsUrl(DocsPage.PlatformAccessControl)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Read more in the docs
            </a>
          </p>
        }
      >
        <div>
          <div className="mb-6">
            <SearchInput
              placeholder="Search roles by name or description..."
              paramName="search"
              className="relative max-w-md"
            />
          </div>

          {!roles || roles.length === 0 ? (
            <div className="text-muted-foreground">
              {searchFilter
                ? "No roles found matching your search"
                : "No roles found"}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={roles}
              sorting={sorting}
              onSortingChange={handleSortingChange}
              manualSorting={true}
              manualPagination={true}
              pagination={{
                pageIndex,
                pageSize,
                total: pagination?.total || 0,
              }}
              onPaginationChange={handlePaginationChange}
            />
          )}

          <div className="mt-6">
            <EnterpriseLicenseRequired featureName="Custom Roles" />
          </div>
        </div>
      </PageLayout>
    </LoadingWrapper>
  );
}

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") {
    return upArrow;
  }
  if (isSorted === "desc") {
    return downArrow;
  }
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}
