import Image from "next/image";
import { Button } from "@/components/ui/button";

export function CursorInstallLink({ href }: { href: string }) {
  return (
    <Button asChild variant="ghost" className="h-auto p-0 hover:bg-transparent">
      <a href={href} aria-label="Add to Cursor">
        <Image
          src="/cursor/mcp-install-light.svg"
          alt=""
          width={126}
          height={28}
          className="dark:hidden"
        />
        <Image
          src="/cursor/mcp-install-dark.svg"
          alt=""
          width={126}
          height={28}
          className="hidden dark:block"
        />
      </a>
    </Button>
  );
}
