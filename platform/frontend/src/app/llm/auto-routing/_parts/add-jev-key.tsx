import Link from "next/link";

/** Where every scorer-blocked state points: the Jev key the session scorer needs. */
export function AddJevKeyLink() {
  return (
    <Link
      href="/llm/model-providers"
      className="text-sm text-primary underline-offset-4 hover:underline"
      data-testid="auto-routing-add-jev-key"
    >
      Add a Jev key
    </Link>
  );
}
