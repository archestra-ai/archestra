import Link from "next/link";
import { Fragment } from "react";

/**
 * The things an action is about, by name: "A", "A and B", "A, B and C", and
 * past three "A, B, C and 4 more".
 *
 * For a confirmation that has to say what it is about to change. An item with
 * an `href` is a link to its own page, so the reader can look before
 * deciding. An item without one is its name alone, set apart from the
 * sentence by weight.
 */
export function ItemNames({
  items,
  onNavigate,
}: {
  items: ReadonlyArray<{ id: string; name: string; href?: string }>;
  /** A link was followed: the dialog it sits in should close. */
  onNavigate?: () => void;
}) {
  const named = items.slice(0, MAX_NAMED);
  const more = items.length - named.length;
  return (
    <>
      {named.map((item, index) => (
        <Fragment key={item.id}>
          {index > 0 && (
            <span>
              {more === 0 && index === named.length - 1 ? " and " : ", "}
            </span>
          )}
          {item.href ? (
            <Link
              href={item.href}
              onClick={onNavigate}
              className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
            >
              {item.name}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{item.name}</span>
          )}
        </Fragment>
      ))}
      {more > 0 && <span> and {more} more</span>}
    </>
  );
}

const MAX_NAMED = 3;
