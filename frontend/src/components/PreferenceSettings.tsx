"use client"

import { useEffect, useState, useRef } from "react"
import { Switch } from "./ui/switch"
import { FolderOpen, Eye, EyeOff } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import Analytics from "@/lib/analytics"
import AnalyticsConsentSwitch from "./AnalyticsConsentSwitch"
import { useConfig, NotificationSettings } from "@/contexts/ConfigContext"
import { useClaude, PANEL_NOTIFICATIONS_STORAGE_KEY } from "@/contexts/ClaudeContext"
import { HANDOFF_ANONYMIZE_STORAGE_KEY, HANDOFF_PREF_SET_STORAGE_KEY } from "@/hooks/useHandoffExport"
import { useCalendar } from "@/contexts/CalendarContext"
import { parseIcs, eventsForToday } from "@/lib/ics"
import { REMINDER_ENABLED_KEY, REMINDER_LEAD_SECS_KEY } from "@/hooks/useMeetingReminder"

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

  // ── Calendar (read-only ICS) ──────────────────────────────────────────────
  const { config: calendarConfig, saveConfig: saveCalendarConfig } = useCalendar();
  const [calUrlInput, setCalUrlInput] = useState('');
  const [calUrlVisible, setCalUrlVisible] = useState(false);
  const [calInterval, setCalInterval] = useState(15);
  const [calSaved, setCalSaved] = useState(false);
  const [calTesting, setCalTesting] = useState(false);
  const [calTestResult, setCalTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Hydrate the calendar inputs once the stored config loads.
  useEffect(() => {
    setCalUrlInput(calendarConfig.icsUrl ?? '');
    setCalInterval(calendarConfig.refreshMinutes ?? 15);
  }, [calendarConfig.icsUrl, calendarConfig.refreshMinutes]);

  const handleTestCalendar = async () => {
    const url = calUrlInput.trim();
    if (!url) return;
    setCalTesting(true);
    setCalTestResult(null);
    try {
      // Test the TYPED url (not the saved one) so the user can validate before saving.
      const ics = await invoke<string>('fetch_calendar_ics', { url });
      const events = parseIcs(ics);
      const today = eventsForToday(events, Date.now());
      setCalTestResult({
        ok: true,
        message: `Connected — ${events.length} ${events.length === 1 ? 'event' : 'events'} found (${today.length} today).`,
      });
    } catch (e) {
      // Never echo the URL. Give a three-part message.
      const reason = typeof e === 'string' ? e : (e as Error)?.message || 'Unknown error';
      setCalTestResult({
        ok: false,
        message: `Couldn't connect. Likely the URL is wrong, the calendar isn't published, or you're offline. Fix the link and try again. (${reason})`,
      });
    } finally {
      setCalTesting(false);
    }
  };

  const handleSaveCalendar = async () => {
    const url = calUrlInput.trim();
    try {
      await saveCalendarConfig(url || null, calInterval);
      setCalSaved(true);
    } catch (e) {
      setCalTestResult({ ok: false, message: `Could not save: ${typeof e === 'string' ? e : (e as Error)?.message}` });
    }
  };

  // ── Clients folder (R2): direct subfolders are offered as filing candidates for calls. ──
  const [clientsRoot, setClientsRoot] = useState('');
  const [clientsRootSaved, setClientsRootSaved] = useState(false);
  useEffect(() => {
    invoke<string>('get_clients_root').then(setClientsRoot).catch(() => {});
  }, []);
  const handleSaveClientsRoot = async () => {
    try {
      await invoke('set_clients_root', { path: clientsRoot.trim() || null });
      // Re-read the effective value (empty falls back to the default).
      const effective = await invoke<string>('get_clients_root');
      setClientsRoot(effective);
      setClientsRootSaved(true);
    } catch {
      /* non-fatal — leave the input as-is */
    }
  };
  const handleBrowseClientsRoot = async () => {
    try {
      const dir = await invoke<string | null>('project_pick_directory', { startingDir: clientsRoot || null });
      if (dir) { setClientsRoot(dir); setClientsRootSaved(false); }
    } catch {
      /* dialog cancelled */
    }
  };

  // Sync input when apiKey loads from backend
  useEffect(() => {
    if (apiKey && !apiKeyInput) setApiKeyInput(apiKey);
  }, [apiKey]);

  // "AI panel notifications" toggle: whether Tandem/Claude Code status notices appear in the AI
  // panel. Hydrated from localStorage in an effect (avoids an SSR hydration mismatch). Default ON.
  const [panelNotifications, setPanelNotifications] = useState(true);
  useEffect(() => {
    try {
      setPanelNotifications(localStorage.getItem(PANEL_NOTIFICATIONS_STORAGE_KEY) !== '0');
    } catch { /* ignore */ }
  }, []);

  // "Meeting reminders" toggle + lead-time: pre-meeting recording prompt (I5). Default ON, 60s.
  // Hydrated from localStorage in an effect (avoids an SSR hydration mismatch).
  const [remindersEnabled, setRemindersEnabled] = useState(true);
  const [reminderLeadSecs, setReminderLeadSecs] = useState(60);
  useEffect(() => {
    try {
      setRemindersEnabled(localStorage.getItem(REMINDER_ENABLED_KEY) !== '0');
      const stored = Number(localStorage.getItem(REMINDER_LEAD_SECS_KEY));
      if (Number.isFinite(stored) && stored > 0) setReminderLeadSecs(stored);
    } catch { /* ignore */ }
  }, []);

  // "Anonymize PII on handoff" toggle: whether HANDOFF.md exports replace PII with surrogates.
  // Hydrated from localStorage in an effect (avoids an SSR hydration mismatch). Default OFF.
  const [handoffAnonymize, setHandoffAnonymize] = useState(false);
  useEffect(() => {
    try {
      setHandoffAnonymize(localStorage.getItem(HANDOFF_ANONYMIZE_STORAGE_KEY) === '1');
    } catch { /* ignore */ }
  }, []);

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [previousNotificationsEnabled, setPreviousNotificationsEnabled] = useState<boolean | null>(null);
  const hasTrackedViewRef = useRef(false);

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

      {/* AI Panel Notifications Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-foreground mb-2">AI panel notifications</h3>
            <p className="text-sm text-muted-foreground">
              Show Tandem and Claude Code status notices in the AI assistant panel. The AI conversation itself is always shown.
            </p>
          </div>
          <Switch
            checked={panelNotifications}
            onCheckedChange={(v) => {
              setPanelNotifications(v);
              try { localStorage.setItem(PANEL_NOTIFICATIONS_STORAGE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
            }}
          />
        </div>
      </div>

      {/* Anonymize PII on Handoff Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Anonymize PII on handoff</h3>
            <p className="text-sm text-muted-foreground">
              Replace names, emails and phone numbers with surrogates in HANDOFF.md exports. Runs automatically on every handoff.
            </p>
          </div>
          <Switch
            checked={handoffAnonymize}
            onCheckedChange={(v) => {
              setHandoffAnonymize(v);
              try {
                localStorage.setItem(HANDOFF_ANONYMIZE_STORAGE_KEY, v ? '1' : '0');
                // Touching this setting counts as making the choice, so the first-run dialog is skipped.
                localStorage.setItem(HANDOFF_PREF_SET_STORAGE_KEY, '1');
              } catch { /* ignore */ }
            }}
          />
        </div>
      </div>

      {/* Keyboard Shortcuts Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-foreground mb-2">Keyboard shortcuts</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Global shortcuts work even when Tandem is in the background.
        </p>
        <ul className="space-y-2.5">
          {[
            { keys: 'Alt+Shift+E', label: 'Start or stop recording (toggle)' },
            { keys: 'Alt+Shift+Q', label: 'Hold to talk to the AI assistant (push-to-talk)' },
            { keys: 'Alt+Shift+A', label: 'Hold to talk to the canvas (push-to-talk)' },
            { keys: 'Alt+Shift+S', label: 'Region screenshot' },
            { keys: 'Alt+Shift+R', label: 'Annotate screenshot' },
            { keys: 'Alt+Shift+V', label: 'Capture clipboard' },
            { keys: 'Ctrl+K', label: 'Command palette' },
          ].map((s) => (
            <li key={s.keys} className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">{s.label}</span>
              <kbd className="shrink-0 rounded border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground tabular-nums">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
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

      {/* Calendar (read-only ICS) Section */}
      <div className="bg-background rounded-lg border border-border p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-foreground mb-1">Calendar</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Show today&apos;s calls on your home screen from a read-only calendar link. Fetched locally,
          nothing leaves your machine. No sign-in required.
        </p>
        <div>
          <label htmlFor="calendar-ics-url" className="block text-sm font-medium text-foreground mb-1">
            Calendar link (ICS URL)
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                id="calendar-ics-url"
                type={calUrlVisible ? 'text' : 'password'}
                value={calUrlInput}
                onChange={(e) => { setCalUrlInput(e.target.value); setCalSaved(false); setCalTestResult(null); }}
                placeholder="https://…/calendar.ics  or  webcal://…"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setCalUrlVisible(!calUrlVisible)}
                aria-label={calUrlVisible ? 'Hide calendar URL' : 'Show calendar URL'}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground"
              >
                {calUrlVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <button
              onClick={handleSaveCalendar}
              disabled={calUrlInput.trim() === (calendarConfig.icsUrl ?? '') && calInterval === calendarConfig.refreshMinutes}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Save
            </button>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <label htmlFor="calendar-interval" className="text-sm text-foreground">Refresh every</label>
            <select
              id="calendar-interval"
              value={calInterval}
              onChange={(e) => { setCalInterval(Number(e.target.value)); setCalSaved(false); }}
              className="px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>60 minutes</option>
            </select>
            <button
              type="button"
              onClick={handleTestCalendar}
              disabled={!calUrlInput.trim() || calTesting}
              className="ml-auto px-3 py-1.5 text-sm font-medium border border-border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {calTesting ? 'Testing…' : 'Test connection'}
            </button>
          </div>

          {calSaved && (
            <p className="mt-2 text-xs text-green-600">Calendar link saved.</p>
          )}
          {calTestResult && (
            <p className={`mt-2 text-xs ${calTestResult.ok ? 'text-green-600' : 'text-destructive'}`}>
              {calTestResult.message}
            </p>
          )}

          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">Outlook</strong> (freshest): Settings → Calendar →
            Shared calendars → Publish a calendar → copy the ICS link.{' '}
            <strong className="font-medium text-foreground">Proton</strong>: share your calendar via link — supported,
            but Proton caches the feed, so same-day changes can take several hours to appear.
            Google secret-ICS links work too.
          </p>
        </div>

        {/* Meeting reminders (I5): pre-call prompt to start recording. */}
        <div className="mt-6 border-t border-border pt-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-medium text-foreground mb-1">Meeting reminders</h4>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Before a scheduled call starts, Tandem prompts you to start recording and suggests
                the folder to file it under. It never starts recording on its own.
              </p>
            </div>
            <Switch
              checked={remindersEnabled}
              onCheckedChange={(v) => {
                setRemindersEnabled(v);
                try { localStorage.setItem(REMINDER_ENABLED_KEY, v ? '1' : '0'); } catch { /* ignore */ }
              }}
              aria-label="Meeting reminders"
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <label htmlFor="reminder-lead" className="text-sm text-foreground">Remind me</label>
            <select
              id="reminder-lead"
              value={reminderLeadSecs}
              disabled={!remindersEnabled}
              onChange={(e) => {
                const secs = Number(e.target.value);
                setReminderLeadSecs(secs);
                try { localStorage.setItem(REMINDER_LEAD_SECS_KEY, String(secs)); } catch { /* ignore */ }
              }}
              className="px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              <option value={30}>30 seconds before</option>
              <option value={60}>1 minute before</option>
              <option value={120}>2 minutes before</option>
              <option value={300}>5 minutes before</option>
            </select>
          </div>
        </div>

        {/* Clients folder (R2): discovered subfolders become filing candidates for calls. */}
        <div className="mt-6 border-t border-border pt-6">
          <label htmlFor="clients-root" className="block text-sm font-medium text-foreground mb-1">
            Clients folder
          </label>
          <div className="flex gap-2">
            <input
              id="clients-root"
              type="text"
              value={clientsRoot}
              onChange={(e) => { setClientsRoot(e.target.value); setClientsRootSaved(false); }}
              placeholder="D:/Dev-projects/Client_projects"
              className="flex-1 px-3 py-2 text-sm bg-background border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            />
            <button
              type="button"
              onClick={handleBrowseClientsRoot}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-border rounded-md hover:bg-muted focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <FolderOpen className="w-4 h-4" />
              Browse
            </button>
            <button
              onClick={handleSaveClientsRoot}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Save
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Direct subfolders are offered as filing candidates for calls, even when they are not
            registered as projects.
          </p>
          {clientsRootSaved && <p className="mt-2 text-xs text-green-600">Clients folder saved.</p>}
        </div>
      </div>
    </div>
  )
}
