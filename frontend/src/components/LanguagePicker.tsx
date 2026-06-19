'use client';

import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, Globe, Check, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfig } from '@/contexts/ConfigContext';
import Analytics from '@/lib/analytics';
import { WhisperAPI } from '@/lib/whisper';
import type { TranscriptModelProps } from './TranscriptSettings';

interface Language {
  code: string;
  name: string;
  short: string;
}

const COMMON: Language[] = [
  { code: 'auto', name: 'Auto Detect', short: 'Auto' },
  { code: 'auto-translate', name: 'Auto + Translate to English', short: 'Auto→EN' },
  { code: 'en', name: 'English', short: 'EN' },
  { code: 'de', name: 'German', short: 'DE' },
  { code: 'es', name: 'Spanish', short: 'ES' },
  { code: 'fr', name: 'French', short: 'FR' },
  { code: 'it', name: 'Italian', short: 'IT' },
  { code: 'pt', name: 'Portuguese', short: 'PT' },
  { code: 'nl', name: 'Dutch', short: 'NL' },
];

const ADDITIONAL: Language[] = [
  { code: 'ja', name: 'Japanese', short: 'JA' },
  { code: 'zh', name: 'Chinese', short: 'ZH' },
  { code: 'ko', name: 'Korean', short: 'KO' },
  { code: 'ru', name: 'Russian', short: 'RU' },
  { code: 'pl', name: 'Polish', short: 'PL' },
  { code: 'tr', name: 'Turkish', short: 'TR' },
  { code: 'ar', name: 'Arabic', short: 'AR' },
  { code: 'sv', name: 'Swedish', short: 'SV' },
  { code: 'da', name: 'Danish', short: 'DA' },
  { code: 'no', name: 'Norwegian', short: 'NO' },
  { code: 'fi', name: 'Finnish', short: 'FI' },
  { code: 'cs', name: 'Czech', short: 'CS' },
  { code: 'el', name: 'Greek', short: 'EL' },
  { code: 'he', name: 'Hebrew', short: 'HE' },
  { code: 'hi', name: 'Hindi', short: 'HI' },
  { code: 'id', name: 'Indonesian', short: 'ID' },
  { code: 'th', name: 'Thai', short: 'TH' },
  { code: 'uk', name: 'Ukrainian', short: 'UK' },
  { code: 'vi', name: 'Vietnamese', short: 'VI' },
];

const ALL = [...COMMON, ...ADDITIONAL];

const AUTO_DETECT_ONLY_PROVIDERS = new Set(['parakeet']);

export function useLanguageMenuState() {
  const { selectedLanguage, setSelectedLanguage } = useConfig();
  const [provider, setProvider] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const refreshProvider = useCallback(async () => {
    try {
      const cfg = await invoke<TranscriptModelProps | null>('api_get_transcript_config');
      setProvider(cfg?.provider ?? null);
    } catch (error) {
      console.warn('LanguagePicker: failed to read transcript config', error);
    }
  }, []);

  useEffect(() => {
    refreshProvider();
  }, [refreshProvider]);

  const current = ALL.find(l => l.code === selectedLanguage) ?? COMMON[0];
  const isAutoDetectOnly = provider !== null && AUTO_DETECT_ONLY_PROVIDERS.has(provider);

  const handleSelect = async (code: string) => {
    if (code === selectedLanguage) return;
    try {
      await invoke('set_language_preference', { language: code });
      setSelectedLanguage(code);
      const lang = ALL.find(l => l.code === code);
      toast.success('Transcription language updated', {
        description: lang ? lang.name : code,
        duration: 2000,
      });
      Analytics.track('language_selected', {
        language_code: code,
        language_name: lang?.name ?? 'Unknown',
        is_auto_detect: (code === 'auto').toString(),
        is_auto_translate: (code === 'auto-translate').toString(),
        source: 'recording_controls',
      });
    } catch (error) {
      console.error('Failed to set language preference:', error);
      toast.error('Failed to set language', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleSwitchToWhisper = async () => {
    setSwitching(true);
    try {
      await WhisperAPI.init().catch(() => undefined);
      const models = await WhisperAPI.getAvailableModels().catch(() => []);
      const installed = models.filter(m => m.status === 'Available').map(m => m.name);
      const preferred =
        installed.find(m => m.includes('large-v3')) ??
        installed.find(m => m.includes('medium')) ??
        installed.find(m => m.includes('small')) ??
        installed[0];

      if (!preferred) {
        toast.error('No Whisper model installed', {
          description: 'Open Settings → Transcription to download one.',
        });
        return;
      }

      await invoke('api_save_transcript_config', {
        provider: 'localWhisper',
        model: preferred,
        apiKey: null,
      });
      await refreshProvider();
      toast.success('Switched to Whisper', {
        description: `Using ${preferred} — language picker now active.`,
      });
    } catch (error) {
      console.error('Failed to switch to Whisper:', error);
      toast.error('Failed to switch provider', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSwitching(false);
    }
  };

  return {
    current,
    isAutoDetectOnly,
    selectedLanguage,
    switching,
    refreshProvider,
    handleSelect,
    handleSwitchToWhisper,
  };
}

interface LanguageMenuItemsProps {
  selectedLanguage: string;
  isAutoDetectOnly: boolean;
  switching: boolean;
  onSelect: (code: string) => void;
  onSwitchToWhisper: () => void;
}

/**
 * Renders the language picker body (warning callout + language radio items).
 * Designed to be embedded inside any DropdownMenuContent or DropdownMenuSubContent.
 */
export function LanguageMenuItems({
  selectedLanguage,
  isAutoDetectOnly,
  switching,
  onSelect,
  onSwitchToWhisper,
}: LanguageMenuItemsProps) {
  const renderItem = (lang: Language) => (
    <DropdownMenuItem
      key={lang.code}
      onSelect={() => onSelect(lang.code)}
      disabled={isAutoDetectOnly && lang.code !== 'auto'}
      className="flex items-center justify-between gap-3"
    >
      <span>{lang.name}</span>
      {lang.code === selectedLanguage ? (
        <Check className="h-3.5 w-3.5 text-foreground" />
      ) : (
        <span className="text-xs text-muted-foreground tabular-nums">{lang.short}</span>
      )}
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenuLabel>Transcription language</DropdownMenuLabel>
      <DropdownMenuSeparator />

      {isAutoDetectOnly && (
        <div className="px-2 py-2 mx-1 my-1 rounded border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="text-xs leading-snug">
              <p className="font-medium">Parakeet only auto-detects</p>
              <p className="mt-1">
                Selecting a language has no effect. Switch to Whisper to force a specific language.
              </p>
              <button
                onClick={onSwitchToWhisper}
                disabled={switching}
                className="mt-2 px-2 py-1 rounded text-xs font-medium bg-amber-200 hover:bg-amber-300 text-amber-900 dark:bg-amber-800 dark:hover:bg-amber-700 dark:text-amber-50 disabled:opacity-50 disabled:pointer-events-none"
              >
                {switching ? 'Switching…' : 'Switch to Whisper'}
              </button>
            </div>
          </div>
        </div>
      )}

      {COMMON.map(renderItem)}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">More</DropdownMenuLabel>
      {ADDITIONAL.map(renderItem)}
    </>
  );
}

interface LanguagePickerProps {
  disabled?: boolean;
}

/**
 * Standalone language picker — kept as a self-contained component for any future
 * placement that wants its own trigger (currently unused; the recording bar uses
 * the submenu form embedded in the mode chevron dropdown).
 */
export function LanguagePicker({ disabled = false }: LanguagePickerProps) {
  const state = useLanguageMenuState();

  return (
    <DropdownMenu onOpenChange={open => { if (open) state.refreshProvider(); }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={disabled}
            className="flex items-center gap-1 px-2 h-7 rounded-full border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 relative"
            aria-label="Transcription language"
          >
            <Globe className="h-3 w-3" />
            <span className="tabular-nums">{state.current.short}</span>
            <ChevronDown className="h-3 w-3 opacity-70" />
            {state.isAutoDetectOnly && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-500 ring-1 ring-background"
                aria-hidden
              />
            )}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {state.isAutoDetectOnly
              ? `Parakeet auto-detects only — open menu to switch to Whisper`
              : `Transcription language: ${state.current.name}`}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64 max-h-[70vh] overflow-y-auto">
        <LanguageMenuItems
          selectedLanguage={state.selectedLanguage}
          isAutoDetectOnly={state.isAutoDetectOnly}
          switching={state.switching}
          onSelect={state.handleSelect}
          onSwitchToWhisper={state.handleSwitchToWhisper}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
