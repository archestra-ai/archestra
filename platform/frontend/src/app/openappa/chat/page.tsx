import { redirect } from "next/navigation";

export default async function OpenAppaChatPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string }>;
}) {
  const { start } = await searchParams;
  redirect(
    start === "review"
      ? "/openappa/configure?start=review"
      : "/openappa/configure",
  );
}
