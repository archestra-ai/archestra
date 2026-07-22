"use client";

import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { useLinkTelegramAccount } from "@/lib/chatops/chatops-config.query";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * Landing page for the bot's /start sign-in link. The code in the URL proves
 * control of a Telegram chat; the session proves who the user is — one click
 * ties them together.
 */
function LinkTelegramContent() {
  const appName = useAppName();
  const searchParams = useSearchParams();
  const code = searchParams.get("code");
  const linkMutation = useLinkTelegramAccount();

  const linked = linkMutation.data?.success === true;
  const failed = linkMutation.data === null;

  return (
    <div className="flex justify-center pt-16 px-4">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border p-8 text-center">
        <Image
          src="/icons/telegram.png"
          alt="Telegram"
          width={48}
          height={48}
        />
        <h1 className="text-lg font-semibold">Link your Telegram account</h1>

        {!code ? (
          <p className="text-sm text-muted-foreground">
            This link is missing its code. Send /start to the bot in Telegram to
            get a fresh link.
          </p>
        ) : linked ? (
          <p className="text-sm text-muted-foreground">
            ✅ Done! Your Telegram account is linked. Go back to Telegram and
            send the bot a message.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              This connects the Telegram chat you messaged the bot from to your{" "}
              {appName} account, so the bot knows who you are.
            </p>
            <Button
              onClick={() => linkMutation.mutate(code)}
              disabled={linkMutation.isPending}
            >
              {linkMutation.isPending ? "Linking…" : "Link Telegram account"}
            </Button>
            {failed && (
              <p className="text-sm text-muted-foreground">
                Linking failed — the code may have expired. Send /start to the
                bot again for a fresh link.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function LinkTelegramPage() {
  return (
    <Suspense fallback={null}>
      <LinkTelegramContent />
    </Suspense>
  );
}
