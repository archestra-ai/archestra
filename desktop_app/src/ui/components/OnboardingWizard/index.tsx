import { ChevronRight, Rocket, Shield, Sparkles, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@ui/components/ui/button';
import { Dialog, DialogContent } from '@ui/components/ui/dialog';
import { useUserStore } from '@ui/stores';

enum OnboardingStep {
  Welcome = 0,
  Features = 1,
  Privacy = 2,
  GetStarted = 3,
}

interface OnboardingWizardProps {
  onOpenChange?: (open: boolean) => void;
}

export default function OnboardingWizard({ onOpenChange }: OnboardingWizardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(OnboardingStep.Welcome);
  const [_countdown, setCountdown] = useState(5);
  const [isButtonEnabled, setIsButtonEnabled] = useState(false);

  const { user, markOnboardingCompleted } = useUserStore();

  useEffect(() => {
    if (user && !user.hasCompletedOnboarding) {
      setIsOpen(true);
    }
  }, [user]);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // Reset countdown when step changes
  useEffect(() => {
    setCountdown(5);
    setIsButtonEnabled(false);

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setIsButtonEnabled(true);
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [currentStep]);

  const completeOnboarding = async () => {
    try {
      await markOnboardingCompleted();
      setIsOpen(false);
    } catch (error) {
      console.error('Failed to complete onboarding:', error);
    }
  };

  const handleNext = () => {
    if (currentStep < OnboardingStep.GetStarted) {
      setCurrentStep(currentStep + 1);
    } else {
      completeOnboarding();
    }
  };

  const handlePrevious = () => {
    if (currentStep > OnboardingStep.Welcome) {
      setCurrentStep(currentStep - 1);
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case OnboardingStep.Welcome:
        return (
          <div className="flex gap-12 h-full">
            <div className="flex-[1.5] min-w-0 flex items-center h-full">
              <div className="w-full aspect-[3/2]">
                <img
                  src="/images/a-group-of-people-connecting-mechanisms-with-wires.png"
                  alt="Welcome to Archestra"
                  className="w-full h-full object-cover rounded-lg"
                  onError={(e) => {
                    // Fallback to placeholder if image doesn't exist
                    e.currentTarget.style.display = 'none';
                    e.currentTarget.nextElementSibling?.classList.remove('hidden');
                  }}
                />
                <div className="hidden w-full h-full bg-gradient-to-br from-blue-100 to-purple-100 dark:from-blue-900/20 dark:to-purple-900/20 rounded-lg flex items-center justify-center">
                  <Sparkles className="w-32 h-32 text-blue-500" />
                </div>
              </div>
            </div>
            <div className="flex-1 flex flex-col justify-center">
              <div>
                <h2 className="text-2xl font-bold">Welcome to Archestra! 👋</h2>
                <p className="text-base text-muted-foreground mt-2">
                  Desktop AI agent with thousands of data connectors.
                </p>
                <p className="text-sm text-muted-foreground mt-4">
                  We hope you don't mind if we take a 1 minute to show you around.
                </p>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button onClick={handleNext} className="min-w-[120px] relative" disabled={!isButtonEnabled}>
                    <span className="flex items-center">
                      Next
                      {!isButtonEnabled ? (
                        <span className="inline-block w-4 h-4 ml-1 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : (
                        <ChevronRight className="w-4 h-4 ml-1" />
                      )}
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );

      case OnboardingStep.Features:
        return (
          <div className="flex gap-12 h-full">
            <div className="flex-[1.5] min-w-0 flex items-center h-full">
              <div className="w-full aspect-[3/2]">
                <img
                  src="/images/a-group-of-people-surrounded-by-a-massive-wooden-f.png"
                  alt="Powerful Features"
                  className="w-full h-full object-cover rounded-lg"
                  onError={(e) => {
                    // Fallback to placeholder if image doesn't exist
                    e.currentTarget.style.display = 'none';
                    e.currentTarget.nextElementSibling?.classList.remove('hidden');
                  }}
                />
                <div className="hidden w-full h-full bg-gradient-to-br from-green-100 to-teal-100 dark:from-green-900/20 dark:to-teal-900/20 rounded-lg flex items-center justify-center">
                  <Zap className="w-32 h-32 text-green-500" />
                </div>
              </div>
            </div>
            <div className="flex-1 flex flex-col justify-center">
              <div>
                <h2 className="text-2xl font-bold">Packed with Security Measures</h2>
                <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
                  AI connected to data without security measures may leak sensitive information. Even worse, the
                  open-source supply chain may be used to attack your machine.
                </p>
                <div className="space-y-3 mt-6">
                  <div className="flex items-start">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mt-0.5">
                      <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">1</span>
                    </div>
                    <p className="ml-3 text-sm text-muted-foreground">
                      Archestra runs open-source MCP servers (connectors) in isolated virtual machines.
                    </p>
                  </div>
                  <div className="flex items-start">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mt-0.5">
                      <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">2</span>
                    </div>
                    <p className="ml-3 text-sm text-muted-foreground">
                      Archestra dynamically manages permissions for AI, reducing the risk of data leaks.
                    </p>
                  </div>
                  <div className="flex items-start">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mt-0.5">
                      <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">3</span>
                    </div>
                    <p className="ml-3 text-sm text-muted-foreground">
                      Archestra keeps dangerous content in envelopes to help avoiding prompt injections.
                    </p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mt-6 leading-relaxed">
                  Sometimes security features cause delays. We're working on improving this!
                </p>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button onClick={handleNext} className="min-w-[120px] relative" disabled={!isButtonEnabled}>
                    <span className="flex items-center">
                      Next
                      {!isButtonEnabled ? (
                        <span className="inline-block w-4 h-4 ml-1 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : (
                        <ChevronRight className="w-4 h-4 ml-1" />
                      )}
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );

      case OnboardingStep.Privacy:
        return (
          <div className="flex gap-12 h-full">
            <div className="flex-[1.5] min-w-0 flex items-center h-full">
              <div className="w-full aspect-[3/2]">
                <img
                  src="/images/a-group-of-people-next-to-the-open-door--green-lan.png"
                  alt="Your Privacy Matters"
                  className="w-full h-full object-cover rounded-lg"
                  onError={(e) => {
                    // Fallback to placeholder if image doesn't exist
                    e.currentTarget.style.display = 'none';
                    e.currentTarget.nextElementSibling?.classList.remove('hidden');
                  }}
                />
                <div className="hidden w-full h-full bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-lg flex items-center justify-center">
                  <Shield className="w-32 h-32 text-indigo-500" />
                </div>
              </div>
            </div>
            <div className="flex-1 flex flex-col justify-center">
              <div>
                <h2 className="text-2xl font-bold">Archestra is Open Source (MIT) and Ready for Enterprises</h2>
                <p className="text-muted-foreground mt-2">
                  Important to note that Archestra also exists as a multi-tenant platform for Enterprises.
                </p>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button onClick={handleNext} className="min-w-[120px] relative" disabled={!isButtonEnabled}>
                    <span className="flex items-center">
                      Next
                      {!isButtonEnabled ? (
                        <span className="inline-block w-4 h-4 ml-1 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : (
                        <ChevronRight className="w-4 h-4 ml-1" />
                      )}
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );

      case OnboardingStep.GetStarted:
        return (
          <div className="flex gap-12 h-full">
            <div className="flex-[1.5] min-w-0 flex items-center h-full">
              <div className="w-full aspect-[3/2]">
                <img
                  src="/images/a-group-of-people-building-a-vessel-in-the-distanc.png"
                  alt="Get Started"
                  className="w-full h-full object-cover rounded-lg"
                  onError={(e) => {
                    // Fallback to placeholder if image doesn't exist
                    e.currentTarget.style.display = 'none';
                    e.currentTarget.nextElementSibling?.classList.remove('hidden');
                  }}
                />
                <div className="hidden w-full h-full bg-gradient-to-br from-orange-100 to-red-100 dark:from-orange-900/20 dark:to-red-900/20 rounded-lg flex items-center justify-center">
                  <Rocket className="w-32 h-32 text-orange-500" />
                </div>
              </div>
            </div>
            <div className="flex-1 flex flex-col justify-center">
              <div>
                <h2 className="text-2xl font-bold">Early Preview Version</h2>
                <p className="text-muted-foreground mt-2">
                  We're working hard on Archestra, but bugs may still happen. Please let us know about them on GitHub!
                </p>
                <div className="p-3 bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 rounded-lg mt-6">
                  <p className="text-sm font-medium text-center">
                    We collect anonymous statistics and error traces. If you disagree with sharing, please wait for the
                    production version to be ready!
                  </p>
                </div>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button onClick={handleNext} className="min-w-[120px] relative" disabled={!isButtonEnabled}>
                    <span className="flex items-center">
                      Get Started
                      {!isButtonEnabled && (
                        <span className="inline-block w-4 h-4 ml-1 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      )}
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-[1200px] w-[90vw] max-h-[70vh] h-[65vh]"
        onPointerDownOutside={(e) => e.preventDefault()}
        showCloseButton={false}
      >
        {renderStepContent()}
      </DialogContent>
    </Dialog>
  );
}
