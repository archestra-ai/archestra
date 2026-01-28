import { Home } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";

function NotFound() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-6 max-w-lg px-6 text-center">
        {/* Large 404 */}
        <div className="relative">
          <h1 className="text-[10rem] sm:text-[12rem] font-bold leading-none text-foreground/[0.08] dark:text-foreground/[0.05] select-none">
            404
          </h1>
        </div>

        {/* Message */}
        <div className="flex flex-col items-center gap-3 -mt-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            Page Not Found
          </h2>
          <p className="text-muted-foreground text-sm max-w-md">
            Sorry! If that's unexpected, please{" "}
            <Link
              href="https://github.com/archestra-ai/archestra/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              let us know
            </Link>
            .
          </p>
        </div>

        {/* Single Action */}
        <div className="w-full max-w-xs mt-2">
          <Button asChild variant="outline" size="lg" className="w-full">
            <Link href="/chat">
              <Home className="mr-2 h-4 w-4" />
              Go to Chat
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function NotFoundPage() {
  return (
    <Suspense>
      <NotFound />
    </Suspense>
  );
}
