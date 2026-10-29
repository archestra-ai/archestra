import Link from "next/link";

/** Where every scorer-blocked state points: the session scorer has no acting user, so only an organization-wide Jev key reaches it. */
export function AddJevKeyLink() {
  return (
    <Link
      href="/llm/model-providers?create=jev&access=organization"
      className="text-sm text-primary underline-offset-4 hover:underline"
      data-testid="auto-routing-add-jev-key"
    >
      Add an organization-wide Jev key
    </Link>
  );
}
