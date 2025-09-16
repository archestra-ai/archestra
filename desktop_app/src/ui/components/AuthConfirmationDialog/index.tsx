import { Shield } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ui/components/ui/dialog';

interface AuthConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isBrowserAuth?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function AuthConfirmationDialog({
  open,
  onOpenChange,
  isBrowserAuth = false,
  onConfirm,
  onCancel,
}: AuthConfirmationDialogProps) {
  const particlesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!particlesRef.current) return;

    if (open) {
      // Clear existing particles
      particlesRef.current.innerHTML = '';

      const numParticles = 30;
      const numShapes = 5;

      // Create particles
      for (let i = 0; i < numParticles; i++) {
        const particle = document.createElement('div');
        particle.className = 'oauth-particle';
        particle.style.left = '-100px';
        particle.style.top = Math.random() * 100 + '%';
        particle.style.animationDelay = Math.random() * 8 + 's';
        particle.style.animationDuration = 8 + Math.random() * 6 + 's';
        particle.style.opacity = '0';

        // Check if dark mode is active
        const isDark = document.documentElement.classList.contains('dark');
        if (!isDark) {
          // Light mode - make particles much darker
          if (i % 3 === 0) {
            particle.style.background = 'rgba(30, 41, 137, 0.9)'; // Very dark blue
          } else if (i % 2 === 0) {
            particle.style.background = 'rgba(55, 35, 75, 0.8)'; // Very dark purple
          } else {
            particle.style.background = 'rgba(40, 53, 177, 0.85)'; // Dark blue
          }
        }

        particlesRef.current.appendChild(particle);
      }

      // Create shapes
      for (let i = 0; i < numShapes; i++) {
        const shape = document.createElement('div');
        shape.className = 'oauth-shape' + (i % 2 === 0 ? ' square' : '');
        const size = 30 + Math.random() * 40;
        shape.style.width = size + 'px';
        shape.style.height = size + 'px';
        shape.style.left = '-150px';
        shape.style.top = Math.random() * 100 + '%';
        shape.style.animationDelay = Math.random() * 15 + 's';
        shape.style.animationDuration = 15 + Math.random() * 10 + 's';
        shape.style.opacity = '0';

        // Check if dark mode is active
        const isDark = document.documentElement.classList.contains('dark');
        if (!isDark) {
          // Light mode - make shapes much darker
          if (i % 2 === 0) {
            shape.style.borderColor = 'rgba(30, 41, 137, 0.6)';
            shape.style.background = 'rgba(30, 41, 137, 0.15)';
          } else {
            shape.style.borderColor = 'rgba(55, 35, 75, 0.6)';
            shape.style.background = 'rgba(55, 35, 75, 0.15)';
          }
        }

        particlesRef.current.appendChild(shape);
      }
    } else {
      // Clear all particles when dialog closes
      particlesRef.current.innerHTML = '';
    }

    // Cleanup on unmount
    return () => {
      if (particlesRef.current) {
        particlesRef.current.innerHTML = '';
      }
    };
  }, [open]);

  return (
    <>
      <style>{`
        @keyframes oauthDrift {
          0% { 
            transform: translateX(-100px);
            opacity: 0;
          }
          5% {
            opacity: 1;
          }
          95% {
            opacity: 1;
          }
          100% {
            transform: translateX(calc(100vw + 100px));
            opacity: 0;
          }
        }

        @keyframes oauthDriftSlow {
          0% {
            transform: translateX(-100px) translateY(0);
            opacity: 0;
          }
          5% {
            opacity: 0.8;
          }
          50% {
            transform: translateX(50vw) translateY(-30px);
          }
          95% {
            opacity: 0.8;
          }
          100% {
            transform: translateX(calc(100vw + 100px)) translateY(0);
            opacity: 0;
          }
        }

        .oauth-particle {
          position: fixed;
          width: 6px;
          height: 6px;
          background: rgba(102, 126, 234, 0.6);
          border-radius: 50%;
          animation: oauthDrift 8s linear infinite;
          pointer-events: none;
          z-index: 51;
        }

        .oauth-particle:nth-child(even) {
          width: 4px;
          height: 4px;
          animation: oauthDriftSlow 12s linear infinite;
          background: rgba(118, 75, 162, 0.5);
        }

        .oauth-particle:nth-child(3n) {
          width: 8px;
          height: 8px;
          animation-duration: 6s;
          background: rgba(102, 126, 234, 0.8);
        }

        .oauth-shape {
          position: fixed;
          border: 2px solid rgba(102, 126, 234, 0.3);
          border-radius: 50%;
          animation: oauthDrift 15s linear infinite;
          background: rgba(102, 126, 234, 0.05);
          pointer-events: none;
          z-index: 51;
        }

        .oauth-shape.square {
          border-radius: 20%;
          animation-duration: 18s;
          border-color: rgba(118, 75, 162, 0.3);
          background: rgba(118, 75, 162, 0.05);
        }
      `}</style>
      <div ref={particlesRef} />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[500px] border-purple-200 dark:border-purple-800" style={{ zIndex: 52 }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-blue-500" />
              MCP authentication magic happening!
            </DialogTitle>
            <DialogDescription className="pt-4 space-y-3">
              {isBrowserAuth ? (
                <p className="text-sm">
                  Archestra will show the browser window and ask you to authenticate. Once you are in, Archestra will
                  extract your API key and use it to interact with the third-party system. Your keys will be stored only
                  in your app!
                </p>
              ) : (
                <p className="text-sm">
                  Archestra cloud will generate the private secrets for you, but it <b>won't store them</b>. All further
                  communication with the third party will happen through your local app!
                </p>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button
              variant="outline"
              onClick={() => {
                onCancel();
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isBrowserAuth ? 'Open Browser...' : 'Continue...'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
