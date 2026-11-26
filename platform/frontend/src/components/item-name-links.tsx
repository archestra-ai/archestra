import Link from "next/link";
import { Fragment } from "react";

/**
 * The things an action is about, by name, each a link to its own page: "A",
 * "A and B", "A, B and C", and past three "A, B, C and 4 more".
 *
 * For a confirmation that has to say what it is about to change. The names
 * are links so the reader can look before deciding.
 */
export function ItemNameLinks({
  items,
  onNavigate,
}: {
  items: ReadonlyArray<{ href: string; name: string }>;
  /** A link was followed: the dialog it sits in should close. */
  onNavigate?: () => void;
}) {
  const named = items.slice(0, MAX_NAMED);
  const more = items.length - named.length;
  return (
    <>
      {named.map((item, index) => (
        <Fragment key={item.href}>
          {index > 0 && (
            <span>
              {more === 0 && index === named.length - 1 ? " and " : ", "}
            </span>
          )}
          <Link
            href={item.href}
            onClick={onNavigate}
            className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
          >
            {item.name}
          </Link>
        </Fragment>
      ))}
      {more > 0 && <span> and {more} more</span>}
    </>
  );
}

const MAX_NAMED = 3;
