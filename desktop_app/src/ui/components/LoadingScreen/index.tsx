import { useEffect, useState } from 'react';

interface LoadingScreenProps {
  isVisible: boolean;
  onComplete: () => void;
  minDuration?: number;
}

export default function LoadingScreen({ isVisible, onComplete, minDuration = 1000 }: LoadingScreenProps) {
  const [shouldShow, setShouldShow] = useState(isVisible);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);

  useEffect(() => {
    if (!isVisible) {
      // Ensure minimum duration before starting fade out
      const timer = setTimeout(() => {
        setIsAnimatingOut(true);
        // Complete fade out animation
        setTimeout(() => {
          setShouldShow(false);
          onComplete();
        }, 800); // Longer fade out for smoother transition
      }, minDuration);

      return () => clearTimeout(timer);
    }
  }, [isVisible, minDuration, onComplete]);

  if (!shouldShow) return null;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center transition-all duration-800 dark ${
        isAnimatingOut ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
      }`}
      style={{
        backgroundColor: 'hsl(var(--background))',
        background: `radial-gradient(ellipse at center, hsl(var(--card)) 0%, hsl(var(--background)) 50%, hsl(var(--muted)) 100%)`,
      }}
    >
      {/* Animated background particles */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="floating-particles">
          {[...Array(12)].map((_, i) => (
            <div
              key={i}
              className="absolute w-1 h-1 rounded-full opacity-20"
              style={{
                backgroundColor: 'hsl(var(--muted-foreground))',
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
                animation: `float ${3 + Math.random() * 4}s ease-in-out infinite`,
                animationDelay: `${Math.random() * 3}s`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Main content container */}
      <div className="relative z-10 flex flex-col items-center">
        {/* Logo container with glow effect */}
        <div className="relative mb-8">
          {/* Glow rings using app theme colors */}
          <div
            className="absolute inset-0 rounded-full blur-xl animate-pulse-glow"
            style={{
              background: `radial-gradient(circle, hsl(var(--primary) / 0.2) 0%, transparent 70%)`,
            }}
          />
          <div
            className="absolute inset-0 rounded-full blur-2xl animate-pulse-glow-delayed"
            style={{
              background: `radial-gradient(circle, hsl(var(--accent) / 0.1) 0%, transparent 70%)`,
            }}
          />

          {/* Logo */}
          <div className="relative">
            <img
              src="./assets/icons/logo.png"
              alt="Archestra"
              className="w-20 h-20 rounded-full relative z-10 shadow-2xl"
              style={{
                animation: 'logoFloat 3s ease-in-out infinite',
                filter: `drop-shadow(0 0 20px hsl(var(--primary) / 0.3))`,
              }}
            />
          </div>
        </div>

        {/* App title with enhanced typography */}
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-4 tracking-wide bg-gradient-to-r from-blue-400 to-purple-600 bg-clip-text text-transparent">
            Archestra
          </h1>
          <p className="text-sm opacity-80" style={{ color: 'hsl(var(--muted-foreground))' }}>
            AI-Powered Development Platform
          </p>
        </div>

        {/* Progress bar using app theme colors */}
        <div className="w-64 h-1 rounded-full mt-8 overflow-hidden" style={{ backgroundColor: 'hsl(var(--border))' }}>
          <div
            className="h-full rounded-full animate-loading-bar"
            style={{
              background: `linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--accent)) 100%)`,
              animation: 'loadingBar 2s ease-in-out infinite',
            }}
          />
        </div>
      </div>

      {/* Initializing workspace text at bottom with animated dots */}
      <div className="absolute bottom-12 left-1/2 transform -translate-x-1/2">
        <div className="flex items-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <span className="text-sm font-medium">Initializing workspace</span>
          <span className="text-sm font-medium ml-1">
            <span
              style={{
                animation: 'dots 1.5s infinite',
              }}
            >
              .
            </span>
            <span
              style={{
                animation: 'dots-delayed-1 1.5s infinite',
              }}
            >
              .
            </span>
            <span
              style={{
                animation: 'dots-delayed-2 1.5s infinite',
              }}
            >
              .
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
