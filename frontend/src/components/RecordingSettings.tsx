import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { FolderOpen, ShieldCheck } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { DeviceSelection, SelectedDevices } from '@/components/DeviceSelection';
import { getConsentGateEnabled, setConsentGateEnabled } from '@/services/consentService';
import Analytics from '@/lib/analytics';
import { toast } from 'sonner';

export interface RecordingPreferences {
  save_folder: string;
  auto_save: boolean;
  file_format: string;
  preferred_mic_device: string | null;
  preferred_system_device: string | null;
}

interface RecordingSettingsProps {
  onSave?: (preferences: RecordingPreferences) => void;
}

export function RecordingSettings({ onSave }: RecordingSettingsProps) {
  const [preferences, setPreferences] = useState<RecordingPreferences>({
    save_folder: '',
    auto_save: true,
    file_format: 'mp4',
    preferred_mic_device: null,
    preferred_system_device: null
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRecordingNotification, setShowRecordingNotification] = useState(true);
  // Defaults to true so a load failure never renders the gate as "off" when it is actually on.
  const [consentGateEnabled, setConsentGateEnabledState] = useState(true);

  // Load recording preferences on component mount
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load recording preferences:', error);
        // If loading fails, get default folder path
        try {
          const defaultPath = await invoke<string>('get_default_recordings_folder_path');
          setPreferences(prev => ({ ...prev, save_folder: defaultPath }));
        } catch (defaultError) {
          console.error('Failed to get default folder path:', defaultError);
        }
      } finally {
        setLoading(false);
      }
    };

    loadPreferences();
  }, []);

  // Load recording notification preference
  useEffect(() => {
    const loadNotificationPref = async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store');
        const store = await Store.load('preferences.json');
        const show = await store.get<boolean>('show_recording_notification') ?? true;
        setShowRecordingNotification(show);
      } catch (error) {
        console.error('Failed to load notification preference:', error);
      }
    };
    loadNotificationPref();
  }, []);

  // Load the pre-record consent gate setting
  useEffect(() => {
    getConsentGateEnabled()
      .then(setConsentGateEnabledState)
      .catch((error) => console.error('Failed to load consent gate setting:', error));
  }, []);

  const handleConsentGateToggle = async (enabled: boolean) => {
    try {
      setConsentGateEnabledState(enabled);
      await setConsentGateEnabled(enabled);
      if (enabled) {
        toast.success('Consent gate enabled');
      } else {
        // Not a neutral preference: turning this off removes the only record that consent was
        // ever obtained, which is what GDPR Art 7(1) requires you to be able to produce.
        toast.warning('Consent gate disabled', {
          description:
            'Recordings will start without a consent record. In Germany, Greece, Portugal, Switzerland and France, recording without every participant’s consent is a criminal offence.',
          duration: 8000,
        });
      }
      await Analytics.track('consent_gate_toggled', { enabled: enabled.toString() });
    } catch (error) {
      console.error('Failed to save consent gate setting:', error);
      // Put the switch back: a UI that says "off" while the gate is on (or vice versa) is worse
      // than the failed write itself.
      setConsentGateEnabledState(!enabled);
      toast.error('Failed to save consent setting');
    }
  };

  const handleAutoSaveToggle = async (enabled: boolean) => {
    const newPreferences = { ...preferences, auto_save: enabled };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track auto-save setting change
    await Analytics.track('auto_save_recording_toggled', {
      enabled: enabled.toString()
    });
  };

  const handleDeviceChange = async (devices: SelectedDevices) => {
    const newPreferences = {
      ...preferences,
      preferred_mic_device: devices.micDevice,
      preferred_system_device: devices.systemDevice
    };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track default device preference changes
    // Note: Individual device selection analytics are tracked in DeviceSelection component
    await Analytics.track('default_devices_changed', {
      has_preferred_microphone: (!!devices.micDevice).toString(),
      has_preferred_system_audio: (!!devices.systemDevice).toString()
    });
  };

  const handleOpenFolder = async () => {
    try {
      await invoke('open_recordings_folder');
    } catch (error) {
      console.error('Failed to open recordings folder:', error);
    }
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    try {
      setShowRecordingNotification(enabled);
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('preferences.json');
      await store.set('show_recording_notification', enabled);
      await store.save();
      toast.success('Preference saved');
      await Analytics.track('recording_notification_preference_changed', {
        enabled: enabled.toString()
      });
    } catch (error) {
      console.error('Failed to save notification preference:', error);
      toast.error('Failed to save preference');
    }
  };

  const savePreferences = async (prefs: RecordingPreferences) => {
    setSaving(true);
    try {
      await invoke('set_recording_preferences', { preferences: prefs });
      onSave?.(prefs);

      // Show success toast with device details
      const micDevice = prefs.preferred_mic_device || 'Default';
      const systemDevice = prefs.preferred_system_device || 'Default';
      toast.success("Device preferences saved", {
        description: `Microphone: ${micDevice}, System Audio: ${systemDevice}`
      });
    } catch (error) {
      console.error('Failed to save recording preferences:', error);
      toast.error("Failed to save device preferences", {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse">
        <div className="h-4 bg-muted rounded w-1/4 mb-4"></div>
        <div className="h-8 bg-muted rounded mb-4"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Recording Settings</h3>
        <p className="text-sm text-muted-foreground mb-6">
          Configure how your audio recordings are saved during meetings.
        </p>
      </div>

      {/* Auto Save Toggle */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1">
          <div className="font-medium">Save Audio Recordings</div>
          <div className="text-sm text-muted-foreground">
            Automatically save audio files when recording stops
          </div>
        </div>
        <Switch
          checked={preferences.auto_save}
          onCheckedChange={handleAutoSaveToggle}
          disabled={saving}
        />
      </div>

      {/* Folder Location - Only shown when auto_save is enabled */}
      {preferences.auto_save && (
        <div className="space-y-4">
          <div className="p-4 border rounded-lg bg-muted">
            <div className="font-medium mb-2">Save Location</div>
            <div className="text-sm text-muted-foreground mb-3 break-all">
              {preferences.save_folder || 'Default folder'}
            </div>
            <button
              onClick={handleOpenFolder}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-border rounded-md hover:bg-muted transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div>

          <div className="p-4 border rounded-lg bg-blue-50 dark:bg-blue-900/20">
            <div className="text-sm text-blue-800 dark:text-blue-300">
              <strong>File Format:</strong> {preferences.file_format.toUpperCase()} files
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">
              Recordings are saved with timestamp: recording_YYYYMMDD_HHMMSS.{preferences.file_format}
            </div>
          </div>
        </div>
      )}

      {/* Info when auto_save is disabled */}
      {!preferences.auto_save && (
        <div className="p-4 border rounded-lg bg-yellow-50 dark:bg-yellow-900/20">
          <div className="text-sm text-yellow-800 dark:text-yellow-300">
            Audio recording is disabled. Enable "Save Audio Recordings" to automatically save your meeting audio.
          </div>
        </div>
      )}

      {/* Consent gate. Placed above the notification toggle because it is the control that
          actually does the compliance work; the toast below is only a confirmation. */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1 pr-4">
          <div className="font-medium flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            Ask for consent before recording
          </div>
          <div className="text-sm text-muted-foreground">
            Confirm who agreed, and how, before capture starts. Writes a consent record you can
            produce later. Recording a call without every participant&apos;s consent is a criminal
            offence in Germany, Greece, Portugal, Switzerland and France.
          </div>
        </div>
        <Switch
          checked={consentGateEnabled}
          onCheckedChange={handleConsentGateToggle}
          aria-label="Ask for consent before recording"
        />
      </div>

      {/* Recording Notification Toggle */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1 pr-4">
          <div className="font-medium">Recording Start Notification</div>
          <div className="text-sm text-muted-foreground">
            Show a confirmation toast when recording starts
          </div>
        </div>
        <Switch
          checked={showRecordingNotification}
          onCheckedChange={handleNotificationToggle}
        />
      </div>

      {/* Device Preferences */}
      <div className="space-y-4">
        <div className="border-t pt-6">
          <h4 className="text-base font-medium text-foreground mb-4">Default Audio Devices</h4>
          <p className="text-sm text-muted-foreground mb-4">
            Set your preferred microphone and system audio devices for recording. These will be automatically selected when starting new recordings.
          </p>

          <div className="border rounded-lg p-4 bg-muted">
            <DeviceSelection
              selectedDevices={{
                micDevice: preferences.preferred_mic_device,
                systemDevice: preferences.preferred_system_device
              }}
              onDeviceChange={handleDeviceChange}
              disabled={saving}
            />
          </div>
        </div>
      </div>
    </div>
  );
}