import type * as React from "react";

/**
 * A bare `<button>` for clickable surfaces that do not look like buttons:
 * whole rows, cards, tiles, listbox options, tree nodes, inline text links,
 * and glyph-sized affordances inside chips. It carries no styling of its own.
 *
 * Anything that reads as a button — a label, an icon in a box, a hover
 * background at a fixed height — uses {@link Button} with a standard size
 * instead. Raw `<button>` elements are linted out of app code, so this is the
 * one deliberate escape hatch; reaching for it to dodge `Button`'s sizes
 * reintroduces the drift the lint rule exists to stop.
 *
 * Defaults `type` to `"button"` so a surface inside a form never submits it.
 */
export function UnstyledButton({
  type = "button",
  ...props
}: React.ComponentProps<"button">) {
  return <button type={type} {...props} />;
}
