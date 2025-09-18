import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import LoadingScreen from '@ui/components/LoadingScreen';
import OnboardingWizard from '@ui/components/OnboardingWizard';

import { router } from './router';

export default function App() {
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showLoadingScreen, setShowLoadingScreen] = useState(true);
  const [appFullyRendered, setAppFullyRendered] = useState(false);
  const renderTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Wait for the app to be fully rendered and stable
    const checkAppReady = () => {
      // Clear any existing timeout
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current);
      }

      // Set a timeout to ensure the app is stable and fully rendered
      renderTimeoutRef.current = setTimeout(() => {
        setAppFullyRendered(true);
        // Additional delay to ensure all components are mounted
        setTimeout(() => {
          setIsLoading(false);
        }, 500);
      }, 1500); // Wait 1.5 seconds for initial render stabilization
    };

    checkAppReady();

    return () => {
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current);
      }
    };
  }, []);

  const handleLoadingComplete = () => {
    setShowLoadingScreen(false);
  };

  return (
    <>
      <LoadingScreen isVisible={isLoading} onComplete={handleLoadingComplete} minDuration={2000} />
      {/* Always render the app, but hide it until loading is complete */}
      <div style={{ visibility: showLoadingScreen ? 'hidden' : 'visible' }}>
        <OnboardingWizard onOpenChange={setIsOnboardingOpen} />
        <div className={`h-full transition-all duration-300 ${isOnboardingOpen ? 'blur-md pointer-events-none' : ''}`}>
          <RouterProvider router={router} />
        </div>
      </div>
    </>
  );
}
