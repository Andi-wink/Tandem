import { useEffect, useState } from 'react';
import { getLocalSpeakerName, LOCAL_SPEAKER_NAME_EVENT } from '@/lib/speakerNames';

/**
 * Reactive local speaker name. Re-renders when the "Your Name" setting changes
 * (same-tab CustomEvent) or when another tab writes localStorage ('storage'),
 * so already-open transcript views update without a reload.
 */
export function useLocalSpeakerName(): string {
  const [name, setName] = useState(getLocalSpeakerName);
  useEffect(() => {
    const update = () => setName(getLocalSpeakerName());
    window.addEventListener(LOCAL_SPEAKER_NAME_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(LOCAL_SPEAKER_NAME_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return name;
}
