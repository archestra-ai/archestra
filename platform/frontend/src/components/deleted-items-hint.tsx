"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Where deleted items come back from, as the closing line of a delete
 * confirmation. A delete here is not the end of an item: it is kept and can
 * be restored, so the confirmation says where.
 *
 * The way back differs by reader. The deleted view of a list is open only to
 * someone who manages every item of the kind, so anyone else is pointed to an
 * admin instead of to a filter they do not have.
 */
export function DeletedItemsHint({
  nounPlural,
  listPath,
  listName,
  canOpenDeletedView,
  onNavigate,
}: {
  /** The items in the plural, lower case: "skills", "plugins". */
  nounPlural: string;
  /** The list's path: "/skills". */
  listPath: string;
  /** The list's page title: "Skills". */
  listName: string;
  canOpenDeletedView: boolean;
  /** The link was followed: the dialog it sits in should close. */
  onNavigate?: () => void;
}) {
  const isOnList = usePathname() === listPath;
  if (!canOpenDeletedView) {
    return <span>An admin can restore deleted {nounPlural}.</span>;
  }
  return (
    <>
      <span>You can restore deleted {nounPlural} from the </span>
      <Link
        // Every deleted item, from the first page: the list's current search
        // and filters are left behind, since the item just deleted may not
        // match them.
        href={`${listPath}?page=1&status=deleted`}
        onClick={onNavigate}
        className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
      >
        Deleted
      </Link>
      <span>
        {isOnList
          ? " filter on this page."
          : ` filter on the ${listName} page.`}
      </span>
    </>
  );
}
