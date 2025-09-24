import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/ui/popover';
import { Switch } from '@ui/components/ui/switch';
import config from '@ui/config';
import { useUserStore } from '@ui/stores';

import getStartedImage from '/images/a-group-of-people-building-a-vessel-in-the-distanc.png';
import {
  default as cloudInferenceImage,
  default as welcomeImage,
} from '/images/a-group-of-people-connecting-mechanisms-with-wires.png';
import privacyImage from '/images/a-group-of-people-next-to-the-open-door--green-lan.png';
import featuresImage from '/images/a-group-of-people-surrounded-by-a-massive-wooden-f.png';

enum OnboardingStep {
  Welcome = 0,
  Features = 1,
  Privacy = 2,
  CloudInference = 3,
  GetStarted = 4,
}

interface OnboardingWizardProps {
  onOpenChange?: (open: boolean) => void;
}

export default function OnboardingWizard({ onOpenChange }: OnboardingWizardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<OnboardingStep>(OnboardingStep.Welcome);
  const [previousStep, setPreviousStep] = useState<OnboardingStep | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const {
    user,
    markOnboardingCompleted,
    toggleTelemetryCollectionStatus,
    toggleAnalyticsCollectionStatus,
    subscribeToUserAuthenticatedEvent,
  } = useUserStore();

  useEffect(() => {
    if (user && !user.hasCompletedOnboarding) {
      setIsOpen(true);
    }
    // Sync preferences with user data
    if (user) {
      setTelemetryEnabled(user.collectTelemetryData ?? true);
      setAnalyticsEnabled(user.collectAnalyticsData ?? true);
    }
  }, [user]);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  const completeOnboarding = useCallback(async () => {
    try {
      await markOnboardingCompleted();
      setIsOpen(false);
    } catch (error) {
      console.error('Failed to complete onboarding:', error);
    }
  }, [markOnboardingCompleted]);

  const handleNext = () => {
    if (currentStep < OnboardingStep.GetStarted) {
      setPreviousStep(currentStep);
      setIsTransitioning(true);
      setCurrentStep(currentStep + 1);
      setTimeout(() => {
        setIsTransitioning(false);
        setPreviousStep(null);
      }, 500); // Animation duration
    } else {
      completeOnboarding();
    }
  };

  const handlePrevious = useCallback(() => {
    if (currentStep > OnboardingStep.Welcome) {
      setPreviousStep(currentStep);
      setIsTransitioning(true);
      setCurrentStep(currentStep - 1);
      setTimeout(() => {
        setIsTransitioning(false);
        setPreviousStep(null);
      }, 500); // Animation duration
    }
  }, [currentStep]);

  const handleTelemetryToggle = useCallback(
    async (checked: boolean) => {
      setTelemetryEnabled(checked);
      await toggleTelemetryCollectionStatus(checked);
    },
    [toggleTelemetryCollectionStatus]
  );

  const handleAnalyticsToggle = useCallback(
    async (checked: boolean) => {
      setAnalyticsEnabled(checked);
      await toggleAnalyticsCollectionStatus(checked);
    },
    [toggleAnalyticsCollectionStatus]
  );

  const handleGoogleSignIn = useCallback(async () => {
    await window.electronAPI.openExternal(config.archestra.cloudLlmProxyAuthUrl);

    // Subscribe to authentication success event and move to next step
    subscribeToUserAuthenticatedEvent('onboarding', () => {
      console.log('User authenticated successfully!');
      handleNext();
    });
  }, [handleNext, subscribeToUserAuthenticatedEvent]);

  const renderStepContent = (step: OnboardingStep) => {
    switch (step) {
      case OnboardingStep.Welcome:
        return (
          <div className="relative w-full h-full overflow-hidden">
            <img
              src={welcomeImage}
              alt="Welcome to Archestra"
              className="absolute inset-0 w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
            <div className="absolute bottom-8 left-8 right-8">
              <div className="bg-white dark:bg-gray-900 rounded-xl p-8 shadow-2xl max-w-2xl">
                <h2 className="text-2xl font-bold">Premier MCP Orchestrator Built for Business</h2>
                <p className="text-lg text-muted-foreground mt-4">
                  We're entering the era of applied agents in enterprise environments. Archestra is the missing
                  component to connect AI and corporate data to make it a reality.
                </p>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button onClick={handleNext} className="min-w-[120px] relative">
                    <span className="flex items-center">
                      Next
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );

      case OnboardingStep.Features:
        return (
          <div className="relative w-full h-full">
            <img src={featuresImage} alt="Powerful Features" className="absolute inset-0 w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
            <div className="absolute bottom-8 left-8 right-8">
              <div className="bg-white dark:bg-gray-900 rounded-xl p-8 shadow-2xl max-w-3xl">
                <h2 className="text-2xl font-bold">Packed with Security Measures</h2>
                <p className="text-base text-muted-foreground mt-3 leading-relaxed">
                  AI connected to data possesses additional security risks.
                </p>
                <div className="space-y-3 mt-6">
                  <div className="flex items-start">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                      <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">1</span>
                    </div>
                    <p className="ml-3 text-base text-muted-foreground mt-0.5">
                      All data processing occurs <span className="font-semibold">locally on your machine</span>, never
                      through cloud services.
                    </p>
                  </div>
                  <div className="flex items-start">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                      <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">2</span>
                    </div>
                    <p className="ml-3 text-base text-muted-foreground mt-0.5">
                      MCP connectors operate within <span className="font-semibold">isolated virtual machines</span> for
                      enhanced security.
                    </p>
                  </div>
                  <div className="flex items-start">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                      <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">3</span>
                    </div>
                    <p className="ml-3 text-base text-muted-foreground mt-0.5">
                      Granular tool permissions ensure controlled data access for each agent.
                    </p>
                  </div>
                </div>
                <p className="text-base text-muted-foreground mt-6 leading-relaxed">
                  Archestra team is dedicated to delivering state-of-the-art agentic security measures, more to come,
                  stay tuned!
                </p>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button onClick={handleNext} className="min-w-[120px] relative">
                    <span className="flex items-center">
                      Next
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );

      case OnboardingStep.Privacy:
        return (
          <div className="relative w-full h-full">
            <img
              src={privacyImage}
              alt="Your Privacy Matters"
              className="absolute inset-0 w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
            <div className="absolute bottom-8 left-8 right-8">
              <div className="bg-white dark:bg-gray-900 rounded-xl p-8 shadow-2xl max-w-2xl">
                <h2 className="text-2xl font-bold">For Everyone, Not Only Engineers</h2>
                <p className="text-lg text-muted-foreground mt-3 leading-relaxed">
                  MCP protocol launched in November 2024 to connect AI with data. While engineers quickly adopted it,
                  non-technical users were left behind. Archestra changes that -{' '}
                  <span className="font-semibold">no API keys, no complex setup</span>. Enabling{' '}
                  <span className="font-semibold">secure, reliable and easy to use AI agents</span> for finance, legal,
                  and every other team.
                </p>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button onClick={handleNext} className="min-w-[120px] relative">
                    <span className="flex items-center">
                      Next
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );

      case OnboardingStep.CloudInference:
        return (
          <div className="relative w-full h-full">
            <img
              src={cloudInferenceImage}
              alt="Cloud Inference"
              className="absolute inset-0 w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
            <div className="absolute bottom-8 left-8 right-8">
              <div className="bg-white dark:bg-gray-900 rounded-xl p-8 shadow-2xl max-w-2xl">
                <h2 className="text-2xl font-bold">Free Cloud Inference for Early Access</h2>
                <p className="text-lg text-muted-foreground mt-4">
                  As an Early Access user, we're providing you with a limited number of free tokens to use our cloud
                  inference service powered by Google's Gemini models.
                </p>
                <p className="text-base text-muted-foreground mt-3">
                  Sign in with Google to activate your free tokens, or skip this step to configure your own AI models
                  locally.
                </p>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button variant="outline" onClick={handleNext} className="min-w-[100px]">
                    Skip
                  </Button>
                  <Button onClick={handleGoogleSignIn} className="min-w-[120px] relative">
                    <span className="flex items-center">Sign In with Google</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );

      case OnboardingStep.GetStarted:
        return (
          <div className="relative w-full h-full">
            <img src={getStartedImage} alt="Get Started" className="absolute inset-0 w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
            <div className="absolute bottom-8 left-8 right-8">
              <div className="bg-white dark:bg-gray-900 rounded-xl p-8 shadow-2xl max-w-2xl">
                <h2 className="text-2xl font-bold">Early Access Program</h2>
                <p className="text-lg text-muted-foreground mt-2">
                  You're among the first to experience Archestra. Your feedback shapes our development - please report
                  any issues on GitHub.
                </p>
                <p className="text-base text-muted-foreground mt-4">
                  We collect anonymous usage analytics and error reports to improve the product. You can opt out of data
                  collection{' '}
                  <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                    <PopoverTrigger asChild>
                      <button className="text-blue-600/80 dark:text-blue-400/80 underline hover:text-blue-700 dark:hover:text-blue-300 font-medium">
                        here
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80">
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <h4 className="font-semibold text-sm">Privacy Settings</h4>
                          <p className="text-xs text-muted-foreground">
                            Control what data we collect to improve Archestra
                          </p>
                        </div>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <Label htmlFor="telemetry" className="text-sm font-medium">
                                Error Reporting
                              </Label>
                              <p className="text-xs text-muted-foreground">Help us fix crashes and bugs</p>
                            </div>
                            <Switch id="telemetry" checked={telemetryEnabled} onCheckedChange={handleTelemetryToggle} />
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <Label htmlFor="analytics" className="text-sm font-medium">
                                Usage Analytics
                              </Label>
                              <p className="text-xs text-muted-foreground">Help us understand feature usage</p>
                            </div>
                            <Switch id="analytics" checked={analyticsEnabled} onCheckedChange={handleAnalyticsToggle} />
                          </div>
                        </div>
                        <div className="pt-2 border-t">
                          <p className="text-xs text-muted-foreground">Changes are saved automatically</p>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                  .
                </p>
                <div className="flex space-x-2 mt-8">
                  {currentStep > OnboardingStep.Welcome && (
                    <Button variant="outline" onClick={handlePrevious}>
                      Previous
                    </Button>
                  )}
                  <Button onClick={handleNext} className="min-w-[120px] relative">
                    <span className="flex items-center">
                      Next
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        );
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        .fade-in {
          animation: fadeIn 500ms ease-in-out forwards;
        }
      `}</style>
      <div className="fixed inset-0 z-50 bg-black" data-testid="onboarding-wizard-dialog">
        {/* Previous step (stays visible during transition) */}
        {previousStep !== null && isTransitioning && (
          <div className="absolute inset-0">{renderStepContent(previousStep)}</div>
        )}

        {/* Current step (fades in on top) */}
        <div className={`absolute inset-0 ${isTransitioning ? 'fade-in' : ''}`}>{renderStepContent(currentStep)}</div>
      </div>
    </>
  );
}
