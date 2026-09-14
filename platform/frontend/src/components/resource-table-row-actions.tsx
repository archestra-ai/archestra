"use client";

import {
  TableRowActions,
  type TableRowActionsProps,
} from "@/components/table-row-actions";
import { useResourceOwnershipTransfer } from "@/components/use-resource-ownership-transfer";

export function ResourceTableRowActions({
  kind,
  resource,
  ...props
}: Omit<TableRowActionsProps, "dropdownContent"> &
  Pick<
    Parameters<typeof useResourceOwnershipTransfer>[0],
    "kind" | "resource"
  >) {
  const ownership = useResourceOwnershipTransfer({ kind, resource });
  return (
    <>
      <TableRowActions {...props} dropdownContent={ownership.menuItem} />
      {ownership.dialog}
    </>
  );
}
