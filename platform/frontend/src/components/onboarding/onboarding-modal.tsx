"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRole } from "@/lib/auth.hook";
import { useSession } from "@/lib/auth.query";
import { useUpdateUserOnboarding } from "@/lib/user.query";
import { Button } from "../ui/button";
import OnboardingWizard, {
  type OnboardingWizardHandle,
} from "./onboarding-wizard";

export default function OnboardingModal() {
  const sessionQuery = useSession();
  const session = sessionQuery.data;
  const userRole = useRole();

  const [open, setOpen] = useState(false);

  const wizardRef = useRef<OnboardingWizardHandle | null>(null);

  const shouldShowOnboarding = Boolean(
    session?.user &&
      session?.user.onboardingCompleted === false &&
      userRole === "admin",
  );

  const updateUserOnboarding = useUpdateUserOnboarding();

  useEffect(() => {
    if (shouldShowOnboarding) {
      setOpen(true);
    }
  }, [shouldShowOnboarding]);
  const completeOnboarding = () => {
    if (session?.user) {
      updateUserOnboarding.mutateAsync({
        id: session.session.userId,
        data: { onboardingCompleted: true },
      });
    }
    // Clear sessionStorage when onboarding is completed
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("onboarding_step");
      sessionStorage.removeItem("onboarding_mode");
      sessionStorage.removeItem("onboarding_agent_id");
      sessionStorage.removeItem("onboarding_mcp_server_id");
    }
    setOpen(false);
  };

  return (
    <Dialog.Root open={open} modal>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-gray-950 overflow-y-auto">
          <div className="fixed inset-0 z-50 overflow-y-auto">
            <div className="min-h-screen flex items-center justify-center p-6">
              <Dialog.Content className="w-full max-w-lg bg-transparent relative outline-none border-none">
                <div className="mb-6 flex justify-center">
                  <Image
                    src="/logo.png"
                    alt="Archestra"
                    width={40}
                    height={40}
                    className="h-10 w-10"
                  />
                </div>

                <div data-slot="dialog-body" className="mt-4">
                  <OnboardingWizard
                    ref={wizardRef}
                    onComplete={completeOnboarding}
                  />
                </div>
                <div className="flex items-center justify-center mt-6">
                  <Button
                    variant="link"
                    type="button"
                    onClick={completeOnboarding}
                  >
                    Skip this step for now
                  </Button>
                </div>
              </Dialog.Content>
            </div>
          </div>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
