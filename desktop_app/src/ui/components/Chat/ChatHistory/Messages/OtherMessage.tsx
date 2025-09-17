import { type TextUIPart, UIMessage } from 'ai';

interface OtherMessageProps {
  message: UIMessage;
}

export default function OtherMessage({ message }: OtherMessageProps) {
  // Extract text content from parts array (UIMessage in ai SDK v5 uses parts)
  let textContent = '';

  if (message.parts) {
    textContent = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as TextUIPart).text)
      .join('');
  }

  return <div className="text-sm whitespace-pre-wrap">{textContent}</div>;
}
