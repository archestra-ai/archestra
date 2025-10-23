"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/auth.query";
import { useHasFirstUserInteraction } from "@/lib/interaction.query";
import OnboardingWizard, {
  type OnboardingWizardHandle,
} from "./onboarding-wizard";

export default function OnboardingModal() {
  const sessionQuery = useSession();
  const session = sessionQuery.data;
  const { data: hasFirstInteraction } = useHasFirstUserInteraction({
    refetchInterval: null,
  });

  const shouldShowOnboarding = Boolean(session?.user && !hasFirstInteraction);
  const [open, setOpen] = useState(false);

  const wizardRef = useRef<OnboardingWizardHandle | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (shouldShowOnboarding) {
      setOpen(true);
    }
  }, [shouldShowOnboarding]);

  const completeOnboarding = () => {
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
                    onStepChange={(s) => setStep(s)}
                    onComplete={completeOnboarding}
                  />
                </div>
                <div className="flex items-center justify-center mt-6">
                  <button
                    type="button"
                    onClick={() =>
                      step < 3
                        ? wizardRef.current?.next()
                        : completeOnboarding()
                    }
                    className="text-sm text-slate-400 hover:text-slate-300 transition-colors"
                  >
                    Skip this step for now
                  </button>
                </div>
              </Dialog.Content>
            </div>
          </div>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
