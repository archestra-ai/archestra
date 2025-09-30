import { useEffect, useRef } from 'react';

interface WaveformVisualizerProps {
  isRecording: boolean;
  className?: string;
}

export function WaveformVisualizer({ isRecording, className = '' }: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>();

  useEffect(() => {
    if (!isRecording || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to match container
    const updateSize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };
    updateSize();

    // Ultra-minimal waveform - very small, subtle bars like OpenAI
    const bars = 30;
    const barWidth = 1.5; // Very thin
    const gap = 2; // Tight spacing
    const heights = Array(bars).fill(0).map(() => Math.random() * 0.2 + 0.1); // Very small heights
    let phase = 0;

    const animate = () => {
      if (!ctx || !canvas) return;

      const width = canvas.width / window.devicePixelRatio;
      const height = canvas.height / window.devicePixelRatio;

      // Clear canvas
      ctx.clearRect(0, 0, width, height);

      // Draw ultra-minimal bars (left-aligned)
      for (let i = 0; i < bars; i++) {
        // Very subtle sine wave animation
        const targetHeight = Math.abs(Math.sin(phase + i * 0.15) * 0.3 + 0.15);
        heights[i] += (targetHeight - heights[i]) * 0.06;

        const barHeight = Math.max(heights[i] * height, 2); // Min 2px height
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;

        // Very subtle gray with low opacity
        ctx.fillStyle = 'rgba(156, 163, 175, 0.4)';
        ctx.fillRect(x, y, barWidth, barHeight);
      }

      phase += 0.03; // Very slow animation
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isRecording]);

  if (!isRecording) return null;

  return (
    <canvas
      ref={canvasRef}
      className={`${className}`}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
