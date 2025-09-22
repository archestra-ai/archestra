import { openai } from '@ai-sdk/openai';
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useChatStore } from '@ui/stores';

interface SpeechSynthesisHook {
  isSpeaking: boolean;
  isSupported: boolean;
  speak: (text: string, options?: SpeechOptions) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  voices: SpeechSynthesisVoice[];
  selectedVoice: SpeechSynthesisVoice | null;
  setSelectedVoice: (voice: SpeechSynthesisVoice | null) => void;
}

interface SpeechOptions {
  voice?: SpeechSynthesisVoice;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export function useSpeechSynthesis(): SpeechSynthesisHook {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      setIsSupported(true);

      const loadVoices = () => {
        const availableVoices = window.speechSynthesis.getVoices();
        setVoices(availableVoices);

        // Select a default voice (prefer English voices)
        if (availableVoices.length > 0 && !selectedVoice) {
          const englishVoice = availableVoices.find((voice) => voice.lang.startsWith('en'));
          setSelectedVoice(englishVoice || availableVoices[0]);
        }
      };

      // Load voices initially
      loadVoices();

      // Some browsers load voices asynchronously
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = loadVoices;
      }
    } else {
      console.log('Speech synthesis is not supported in this browser.');
      setIsSupported(false);
    }

    return () => {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speak = useCallback(
    async (text: string, options?: SpeechOptions) => {
      if (!text) return;

      // Cancel any ongoing speech
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }

      setIsSpeaking(true);

      try {
        // Try using AI SDK speech generation for supported models first
        const { selectedModel } = useChatStore.getState();
        const isOpenAIModel = selectedModel && (selectedModel.includes('gpt-4') || selectedModel.includes('openai'));

        if (isOpenAIModel && isSupported) {
          try {
            // Use AI SDK experimental speech generation
            const audio = await generateSpeech({
              model: openai.speech('tts-1'),
              text: text.slice(0, 4096), // OpenAI TTS has text length limits
              voice: 'alloy',
            });

            // Create audio element and play
            const audioElement = new Audio();
            const audioBlob = new Blob([audio.audioData], { type: 'audio/mpeg' });
            const audioUrl = URL.createObjectURL(audioBlob);
            audioElement.src = audioUrl;

            audioElement.onended = () => {
              setIsSpeaking(false);
              URL.revokeObjectURL(audioUrl);
            };

            audioElement.onerror = () => {
              setIsSpeaking(false);
              URL.revokeObjectURL(audioUrl);
              // Fallback to browser speech synthesis
              fallbackToWebSpeech(text, options);
            };

            await audioElement.play();
            return;
          } catch (error) {
            console.warn('AI SDK speech generation failed, falling back to browser speech:', error);
            // Continue to fallback
          }
        }

        // Fallback to browser speech synthesis
        fallbackToWebSpeech(text, options);
      } catch (error) {
        console.error('Speech synthesis error:', error);
        setIsSpeaking(false);
      }
    },
    [isSupported, selectedVoice]
  );

  const fallbackToWebSpeech = useCallback(
    (text: string, options?: SpeechOptions) => {
      if (!isSupported) {
        setIsSpeaking(false);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);

      // Set voice
      if (options?.voice) {
        utterance.voice = options.voice;
      } else if (selectedVoice) {
        utterance.voice = selectedVoice;
      }

      // Set other options
      utterance.rate = options?.rate || 1.0;
      utterance.pitch = options?.pitch || 1.0;
      utterance.volume = options?.volume || 1.0;

      // Set up event handlers
      utterance.onstart = () => {
        setIsSpeaking(true);
      };

      utterance.onend = () => {
        setIsSpeaking(false);
      };

      utterance.onerror = (event) => {
        console.error('Speech synthesis error:', event);
        setIsSpeaking(false);
      };

      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [isSupported, selectedVoice]
  );

  const pause = useCallback(() => {
    if (isSupported && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
      setIsSpeaking(false);
    }
  }, [isSupported]);

  const resume = useCallback(() => {
    if (isSupported && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setIsSpeaking(true);
    }
  }, [isSupported]);

  const stop = useCallback(() => {
    if (isSupported) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, [isSupported]);

  return {
    isSpeaking,
    isSupported,
    speak,
    pause,
    resume,
    stop,
    voices,
    selectedVoice,
    setSelectedVoice,
  };
}
