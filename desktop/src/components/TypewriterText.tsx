import { useTypewriter } from '../hooks/use-typewriter';

interface TypewriterTextProps {
  text: string;
  speed?: number;
  className?: string;
}

export function TypewriterText({ text, speed = 30, className }: TypewriterTextProps) {
  const safeText = text || '';
  const { displayedText, isComplete } = useTypewriter(safeText, speed);

  return (
    <span className={className}>
      {displayedText}
      {!isComplete && <span className="animate-pulse">|</span>}
    </span>
  );
}
