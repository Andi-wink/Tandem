"use client"

import { useEffect, useState, useRef } from "react"
import { Switch } from "./ui/switch"
import { FolderOpen, Eye, EyeOff, Loader2 } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import Analytics from "@/lib/analytics"
import AnalyticsConsentSwitch from "./AnalyticsConsentSwitch"
import { useConfig, NotificationSettings } from "@/contexts/ConfigContext"
import { useClaude } from "@/contexts/ClaudeContext"
import { getDiarizationHealth, setupDiarizationModel, DiarizationHealth } from "@/services/diarizationService"
import { toast } from "sonner"

export function PreferenceSettings() {
  const {
    notificationSettings,
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings
  } = useConfig();
  const { apiKey, setApiKey } = useClaude();
  const [apiKeyInput, setApiKeyInput] = useState(apiKey ?? '');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeySaved, setApiKeySaved] = useState(false);

  // Sync input when apiKey loads from backend
  useEffect(() => {
    if (apiKey && !apiKeyInput) setApiKeyInput(apiKey);
  }, [apiKey]);

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [previousNotificationsEnabled, setPreviousNotificationsEnabled] = useState<boolean | null>(null);
  const hasTrackedViewRef = useRef(false);

  // F022: Speaker Diarization settings
  const [diarHealth, setDiarHealth] = useState<DiarizationHealth | null>(null);
  const [hfTokenInput, setHfTokenInput] = useState('');
  const [hfTokenVisible, setHfTokenVisible] = useState(false);
  const [diarSetupLoading, setDiarSetupLoading] = useState(false);
  const [autoDiarize, setAutoDiarize] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('tandem_auto_diarize') === 'true' : false
  );

  // Lazy load preferences on mount (only loads if not already cached)
  useEffect(() => {
    loadPreferences();
    // Reset tracking ref on mount (every tab visit)
    hasTrackedViewRef.current = false;
  }, [loadPreferences]);

  // Track preferences viewed analytics on every tab visit (once per mount)
  useEffect(() => {
    if (hasTrackedViewRef.current) return;

    const trackPreferencesViewed = async () => {
      // Wait for notification settings to be available (either from cache or after loading)
      if (notificationSettings) {
        await Analytics.track('preferences_viewed', {
          notifications_enabled: notificationSettings.notification_preferences.show_recording_started ? 'true' : 'false'
        });
        hasTrackedViewRef.current = true;
      } else if (!isLoadingPreferences) {
        // If not loading and no settings available, track with default value
        await Analytics.track('preferences_viewed', {
          notifications_enabled: 'false'
        });
        hasTrackedViewRef.current = true;
      }
    };

    trackPreferencesViewed();
  }, [notificationSettings, isLoadingPreferences]);

  // F022: Load diarization health on mount
  useEffect(() => {
    getDiarizationHealth().then(setDiarHealth).catch(() => setDiarHealth(null));
  }, []);

  // Update notificationsEnabled when notificationSettings are loaded from global state
  useEffect(() => {
    if (notificationSettings) {
      // Notification enabled means both started and stopped notifications are enabled
      const enabled =
        notificationSettings.notification_preferences.show_recording_started &&
        notificationSettings.notification_preferences.show_recording_stopped;
      setNotificationsEnabled(enabled);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(enabled);
        setIsInitialLoad(false);
      }
    } else if (!isLoadingPreferences) {
      // If not loading and no settings, use default
      setNotificationsEnabled(true);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(true);
        setIsInitialLoad(false);
      }
    }
  }, [notificationSettings, isLoadingPreferences, isInitialLoad])

  useEffect(() => {
    // Skip update on initial load or if value hasn't actually changed
    if (isInitialLoad || notificationsEnabled === null || notificationsEnabled === previousNotificationsEnabled) return;
    if (!notificationSettings) return;

    const handleUpdateNotificationSettings = async () => {
      console.log("Updating notification settings to:", notificationsEnabled);

      try {
        // Update the notification preferences
        const updatedSettings: NotificationSettings = {
          ...notificationSettings,
          notification_preferences: {
            ...notificationSettings.notification_preferences,
            show_recording_started: notificationsEnabled,
            show_recording_stopped: notificationsEnabled,
          }
        };

        console.log("Calling updateNotificationSettings with:", updatedSettings);
        await updateNotificationSettings(updatedSettings);
        setPreviousNotificationsEnabled(notificationsEnabled);
        console.log("Successfully updated notification settings to:", notificationsEnabled);

        // Track notification preference change - only fires when user manually toggles
        await Analytics.track('notification_settings_changed', {
          notifications_enabled: notificationsEnabled.toString()
        });
      } catch (error) {
        console.error('Failed to update notification settings:', error);
      }
    };

    handleUpdateNotificationSettings();
  }, [notificationsEnabled, notificationSettings, isInitialLoad, previousNotificationsEnabled, updateNotificationSettings])

  const handleOpenFolder = async (folderType: 'database' | 'models' | 'recordings') => {
    try {
      switch (folderType) {
        case 'database':
          await invoke('open_database_folder');
          break;
        case 'models':
          await invoke('open_models_folder');
          break;
        case 'recordings':
          await invoke('open_recordings_folder');
          break;
      }

      // Track storage folder access
      await Analytics.track('storage_folder_opened', {
        folder_type: folderType
      });
    } catch (error) {
      console.error(`Failed to open ${folderType} folder:`, error);
    }
  };

  // Show loading only if we're actually loading and don't have cached data
  if (isLoadingPreferences && !notificationSettings && !storageLocations) {
    return <div className="max-w-2xl mx-auto p-6">Loading Preferences...</div>
  }

  // Show loading if notificationsEnabled hasn't been determined yet
  if (notificationsEnabled === null && !isLoadingPreferences) {
    return <div className="max-w-2xl mx-auto p-6">Loading Preferences...</div>
  }

  // Ensure we have a boolean value for the Switch component
  const notificationsEnabledValue = notificationsEnabled ?? false;

  return (
    <div className="space-y-6">
      {/* Notifications Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Notifications</h3>
            <p className="text-sm text-muted-foreground">Enable or disable notifications of start and end of meeting</p>
          </div>
          <Switch checked={notificationsEnabledValue} onCheckedChange={setNotificationsEnabled} />
        </div>
      </div>

      {/* Data Storage Locations Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-foreground mb-4">Data Storage Locations</h3>
        <p className="text-sm text-muted-foreground mb-6">
          View and access where Tandem stores your data
        </p>

        <div className="space-y-4">
          {/* Database Location */}
          {/* <div className="p-4 border rounded-lg bg-muted">
            <div className="font-medium mb-2">Database</div>
            <div className="text-sm text-muted-foreground mb-3 break-all font-mono text-xs">
              {storageLocations?.database || 'Loading...'}
            </div>
            <button
              onClick={() => handleOpenFolder('database')}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-md hover:bg-accent transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div> */}

          {/* Models Location */}
          {/* <div className="p-4 border rounded-lg bg-muted">
            <div className="font-medium mb-2">Whisper Models</div>
            <div className="text-sm text-muted-foreground mb-3 break-all font-mono text-xs">
              {storageLocations?.models || 'Loading...'}
            </div>
            <button
              onClick={() => handleOpenFolder('models')}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-md hover:bg-accent transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div> */}

          {/* Recordings Location */}
          <div className="p-4 border rounded-lg bg-muted">
            <div className="font-medium mb-2">Meeting Recordings</div>
            <div className="text-sm text-muted-foreground mb-3 break-all font-mono text-xs">
              {storageLocations?.recordings || 'Loading...'}
            </div>
            <button
              onClick={() => handleOpenFolder('recordings')}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-md hover:bg-accent transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div>
        </div>

        <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-950 rounded-md">
          <p className="text-xs text-blue-800 dark:text-blue-200">
            <strong>Note:</strong> Database and models are stored together in your application data directory for unified management.
          </p>
        </div>
      </div>

      {/* Analytics Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <AnalyticsConsentSwitch />
      </div>

      {/* F022: Speaker Diarization Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-foreground mb-1">Speaker Diarization</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Identify who said what using on-device speaker recognition (pyannote.audio).
        </p>

        {/* Status indicator */}
        <div className="mb-4 p-3 rounded-md border border-border bg-muted">
          <div className="flex items-center gap-2 text-sm">
            <span className={`w-2 h-2 rounded-full ${diarHealth?.available ? 'bg-green-500' : diarHealth?.installed ? 'bg-yellow-500' : 'bg-red-500'}`} />
            <span className="text-foreground font-medium">
              {diarHealth?.available
                ? `Model loaded (${diarHealth.device?.toUpperCase()})`
                : diarHealth?.installed
                  ? 'Package installed, model not loaded'
                  : 'Not installed'}
            </span>
          </div>
        </div>

        {/* HuggingFace token + Download Model */}
        {!diarHealth?.available && diarHealth?.installed && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-foreground mb-1">
              HuggingFace Token
            </label>
            <p className="text-xs text-muted-foreground mb-2">
              Required for one-time model download (~1GB). Get a free token at{' '}
              <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                huggingface.co/settings/tokens
              </a>
            </p>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={hfTokenVisible ? 'text' : 'password'}
                  value={hfTokenInput}
                  onChange={(e) => setHfTokenInput(e.target.value)}
                  placeholder="hf_..."
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setHfTokenVisible(!hfTokenVisible)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {hfTokenVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <button
                onClick={async () => {
                  if (!hfTokenInput.trim()) return;
                  setDiarSetupLoading(true);
                  try {
                    const result = await setupDiarizationModel(hfTokenInput.trim());
                    toast.success(result.message);
                    setDiarHealth({ installed: true, available: true, device: result.device });
                  } catch (err) {
                    toast.error(`Setup failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
                  } finally {
                    setDiarSetupLoading(false);
                  }
                }}
                disabled={!hfTokenInput.trim() || diarSetupLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 flex items-center gap-1.5"
              >
                {diarSetupLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {diarSetupLoading ? 'Downloading...' : 'Download Model'}
              </button>
            </div>
          </div>
        )}

        {/* Auto-diarize toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Auto-identify speakers</p>
            <p className="text-xs text-muted-foreground">Automatically run diarization after each recording stops</p>
          </div>
          <Switch
            checked={autoDiarize}
            onCheckedChange={(checked) => {
              setAutoDiarize(checked);
              localStorage.setItem('tandem_auto_diarize', String(checked));
            }}
            disabled={!diarHealth?.available}
          />
        </div>
      </div>

      {/* AI Assistant API Key Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-foreground mb-1">AI Assistant (Claude)</h3>
        <p className="text-sm text-muted-foreground mb-4">
          API key for the in-app AI assistant panel. Stored locally in the app database.
        </p>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Anthropic API Key
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={apiKeyVisible ? 'text' : 'password'}
                value={apiKeyInput}
                onChange={(e) => { setApiKeyInput(e.target.value); setApiKeySaved(false); }}
                placeholder="sk-ant-..."
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setApiKeyVisible(!apiKeyVisible)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground"
              >
                {apiKeyVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <button
              onClick={() => {
                if (apiKeyInput.trim()) {
                  setApiKey(apiKeyInput.trim());
                  setApiKeySaved(true);
                }
              }}
              disabled={!apiKeyInput.trim() || apiKeyInput.trim() === apiKey}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Save
            </button>
          </div>
          {(apiKey || apiKeySaved) && (
            <p className="mt-1.5 text-xs text-green-600">Key is set and saved.</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Get your key at{' '}
            <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              console.anthropic.com
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
