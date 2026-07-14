/**
 * Playwright fixture that injects Tauri IPC mocks via page.addInitScript().
 * This must run BEFORE any app JS loads so that @tauri-apps/api/core finds
 * window.__TAURI_INTERNALS__ already present.
 */
import { test as base, Page } from '@playwright/test';

// The init script is a plain string — it executes in the browser context
// before any module code. It cannot import Node modules.
const TAURI_MOCK_SCRIPT = `
(function() {
  // ---- Event system plumbing ----
  const _eventListeners = new Map();
  let _nextId = 1;
  const _callbacks = new Map();

  function _registerCallback(cb) {
    const id = _nextId++;
    _callbacks.set(id, cb);
    return id;
  }
  function _unregisterCallback(id) { _callbacks.delete(id); }
  function _runCallback(id, data) {
    const cb = _callbacks.get(id);
    if (cb) cb(data);
  }

  function _handleEventPlugin(cmd, args) {
    if (cmd === 'plugin:event|listen') {
      const list = _eventListeners.get(args.event) || [];
      list.push(args.handler);
      _eventListeners.set(args.event, list);
      return args.handler;
    }
    if (cmd === 'plugin:event|unlisten') {
      const list = _eventListeners.get(args.event);
      if (list) {
        const idx = list.indexOf(args.eventId);
        if (idx !== -1) list.splice(idx, 1);
      }
      return null;
    }
    if (cmd === 'plugin:event|emit') {
      const handlers = _eventListeners.get(args.event) || [];
      for (const hid of handlers) {
        _runCallback(hid, { event: args.event, payload: args.payload });
      }
      return null;
    }
    return null;
  }

  // ---- Mock invoke ----
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    transformCallback: _registerCallback,
    unregisterCallback: _unregisterCallback,
    runCallback: _runCallback,
    callbacks: _callbacks,
    convertFileSrc: function(path, protocol) {
      protocol = protocol || 'asset';
      return 'http://' + protocol + '.localhost/' + encodeURIComponent(path);
    },

    invoke: async function(cmd, args) {
      // Record every invoke so specs can assert what the UI called.
      if (!window.__TAURI_MOCK_CALLS__) window.__TAURI_MOCK_CALLS__ = [];
      window.__TAURI_MOCK_CALLS__.push({ cmd: cmd, args: args });

      // Event plugin commands
      if (cmd.startsWith('plugin:event|')) return _handleEventPlugin(cmd, args);

      switch (cmd) {
        // ---- Solo projects + client-folder discovery (R2) ----
        case 'project_list':
          return [
            { id: 'acme', name: 'Acme', path: 'D:/Dev-projects/Client_projects/Acme',
              aliases: '[]', auto_discovered: 0, created_at: '2026-01-01', updated_at: '2026-01-01' },
          ];
        case 'project_create':
          return {
            id: 'created-' + ((args && args.name) || 'x'),
            name: (args && args.name) || 'Project',
            path: (args && args.path) || '',
            aliases: (args && args.aliases) || '[]',
            auto_discovered: 0, created_at: '2026-01-01', updated_at: '2026-01-01',
          };
        case 'list_client_folders':
          return [
            { name: 'Globex', path: 'D:/Dev-projects/Client_projects/Globex' },
            { name: 'ARO', path: 'D:/Dev-projects/Client_projects/ARO' },
            { name: 'Openclaw', path: 'D:/Dev-projects/Client_projects/Openclaw' },
            { name: 'n8n', path: 'D:/Dev-projects/Client_projects/n8n' },
          ];
        case 'get_clients_root':
          return 'D:/Dev-projects/Client_projects';
        case 'set_clients_root':
          return null;
        case 'get_recordings_base_dir':
          return 'C:\\\\Users\\\\test\\\\.meetily\\\\recordings';
        case 'relocate_meeting_folder':
          return ((args && args.destParentDir) || 'C:/dest') + '/Meeting moved';
        case 'show_in_folder':
          return null;
        case 'start_recording':
        case 'start_recording_with_devices_and_meeting':
        case 'start_recording_with_devices':
          return null;
        // ---- Layout.tsx (blocks entire app) ----
        case 'get_onboarding_status':
          return { completed: true, version: '1.0', current_step: 4,
                   model_status: { parakeet: 'downloaded', summary: 'downloaded' },
                   last_updated: new Date().toISOString() };

        // ---- SidebarProvider ----
        case 'api_get_meetings':
          return [
            { id: 'meeting-1', title: 'Team Standup 2026-02-23' },
            { id: 'meeting-2', title: 'Product Review' },
            { id: 'meeting-3', title: 'Sprint Planning' },
          ];

        // ---- RecordingStateContext ----
        case 'get_recording_state':
          return { is_recording: false, is_paused: false, is_active: false,
                   recording_duration: null, active_duration: null };
        case 'is_recording':
          return false;

        // ---- ConfigContext ----
        case 'api_get_model_config':
          return { provider: 'ollama', model: 'llama3.2:latest',
                   whisperModel: 'large-v3', ollamaEndpoint: null };
        case 'api_get_transcript_config':
          return { provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3-int8', apiKey: null };
        case 'get_language_preference':
          return 'auto-translate';
        case 'get_recording_preferences':
          return { preferred_mic_device: null, preferred_system_device: null };
        case 'get_ollama_models':
          return [{ name: 'llama3.2:latest', id: 'llama3.2:latest', size: '2.0 GB', modified: '2026-01-01' }];
        case 'api_get_api_key':
        case 'api_get_transcript_api_key':
          return null;
        case 'api_get_custom_openai_config':
          return null;
        case 'api_get_auto_generate_setting':
          return false;

        // ---- OnboardingContext ----
        case 'check_first_launch':
          return false;
        case 'builtin_ai_get_recommended_model':
          return 'gemma3:1b';
        case 'parakeet_init':
        case 'parakeet_has_available_models':
          return true;
        case 'parakeet_get_available_models':
          return [];
        case 'builtin_ai_get_available_summary_model':
          return 'gemma3:1b';

        // ---- TranscriptContext ----
        case 'get_transcript_history':
          return [];
        case 'get_recording_meeting_name':
          return null;

        // ---- Home page ----
        case 'get_meeting_folder_path':
          return 'C:\\\\Users\\\\test\\\\meetings';

        // ---- Calendar (read-only ICS) ----
        case 'api_get_calendar_config':
          return { icsUrl: 'https://example.com/secret/cal.ics', refreshMinutes: 15 };
        case 'api_save_calendar_config':
          return null;
        case 'fetch_calendar_ics': {
          // Build a valid ICS with one event TODAY (14:00-14:30 UTC, Zoom link) and one TOMORROW,
          // so agenda tests always have a deterministic "today" row.
          var _pad = function(n) { return String(n).padStart(2, '0'); };
          var _now = new Date();
          var _today = _now.getUTCFullYear() + _pad(_now.getUTCMonth() + 1) + _pad(_now.getUTCDate());
          var _tmr = new Date(_now.getTime() + 24 * 60 * 60 * 1000);
          var _tomorrow = _tmr.getUTCFullYear() + _pad(_tmr.getUTCMonth() + 1) + _pad(_tmr.getUTCDate());
          return [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Tandem Test//EN',
            'BEGIN:VEVENT',
            'UID:today-1',
            'SUMMARY:Acme discovery call',
            'DTSTART:' + _today + 'T140000Z',
            'DTEND:' + _today + 'T143000Z',
            'LOCATION:https://us02web.zoom.us/j/8412345678?pwd=abcd',
            'ATTENDEE;CN=Jane Client:mailto:jane@acme.com',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:today-2',
            'SUMMARY:Globex roadmap review',
            'DTSTART:' + _today + 'T160000Z',
            'DTEND:' + _today + 'T163000Z',
            'ATTENDEE;CN=Jane Client:mailto:jane@acme.com',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:tmr-1',
            'SUMMARY:Beta strategy sync',
            'DTSTART:' + _tomorrow + 'T100000Z',
            'DTEND:' + _tomorrow + 'T103000Z',
            'END:VEVENT',
            'END:VCALENDAR',
          ].join('\\n');
        }

        // ---- Audio devices ----
        case 'get_audio_devices':
          return [
            { name: 'Built-in Microphone', device_type: 'Input' },
            { name: 'Speakers', device_type: 'Output' },
          ];
        case 'get_audio_backend_info':
          return [{ id: 'wasapi', name: 'WASAPI', available: true }];
        case 'get_current_audio_backend':
          return 'wasapi';

        // ---- Meeting details ----
        case 'api_get_meeting_metadata':
          return null;
        case 'api_get_meeting_transcripts':
          return { transcripts: [], total: 0, has_more: false };
        case 'api_get_meeting_screenshots':
        case 'api_get_meeting_clipboard_items':
        case 'load_screenshots_json':
        case 'load_clipboard_json':
          return [];
        case 'api_get_summary':
          return { status: 'idle', data: null };
        case 'api_list_templates':
          return [];
        case 'api_search_transcripts':
          return [];

        // ---- Settings / preferences ----
        case 'get_notification_settings':
          return null;
        case 'get_database_directory':
          return 'C:\\\\Users\\\\test\\\\.meetily\\\\db';
        case 'whisper_get_models_directory':
          return 'C:\\\\Users\\\\test\\\\.meetily\\\\models';
        case 'get_default_recordings_folder_path':
          return 'C:\\\\Users\\\\test\\\\.meetily\\\\recordings';

        // ---- Plugin: store (AnalyticsProvider) ----
        case 'plugin:store|load':
          return 1;
        case 'plugin:store|get':
          if (args && args.key === 'analyticsOptedIn') return [false, true];
          return [null, false];
        case 'plugin:store|has':
          return false;
        case 'plugin:store|set':
        case 'plugin:store|save':
          return null;

        // ---- Plugin: updater ----
        case 'plugin:updater|check':
          return null;

        // ---- Plugin: app ----
        case 'plugin:app|version':
          return '0.2.1';

        // ---- Plugin: os ----
        case 'plugin:os|platform':
          return 'windows';
        case 'plugin:os|arch':
          return 'x86_64';

        // ---- Analytics (all no-op) ----
        case 'init_analytics':
        case 'disable_analytics':
        case 'track_event':
        case 'identify_user':
        case 'start_analytics_session':
        case 'end_analytics_session':
        case 'track_daily_active_user':
        case 'track_user_first_launch':
        case 'track_meeting_started':
        case 'track_recording_started':
        case 'track_recording_stopped':
        case 'track_meeting_deleted':
        case 'track_settings_changed':
        case 'track_feature_used':
        case 'track_summary_generation_completed':
        case 'track_summary_regenerated':
        case 'track_model_changed':
        case 'track_custom_prompt_used':
        case 'track_analytics_transparency_viewed':
        case 'track_analytics_enabled':
        case 'track_analytics_disabled':
          return null;
        case 'is_analytics_enabled':
        case 'is_analytics_session_active':
          return false;

        // ---- Write/save commands (no-op) ----
        case 'save_onboarding_status_cmd':
        case 'api_save_model_config':
        case 'api_save_transcript_config':
        case 'api_save_meeting_title':
        case 'api_delete_meeting':
        case 'set_notification_settings':
        case 'set_language_preference':
        case 'set_recording_preferences':
        case 'complete_onboarding':
        case 'api_save_custom_openai_config':
          return null;

        default:
          console.warn('[TAURI_MOCK] Unhandled command:', cmd, JSON.stringify(args));
          return null;
      }
    },
  };

  // Detection flags used by usePlatform / useRecordingStateSync
  window.__TAURI__ = true;

  // Event plugin internals
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function(event, id) { _unregisterCallback(id); },
  };

  console.log('[TAURI_MOCK] Initialized');
})();
`;

// ── Custom fixture ──────────────────────────────────────────────────────────

type TauriFixtures = {
  tauriPage: Page;
};

export const test = base.extend<TauriFixtures>({
  tauriPage: async ({ page }, use) => {
    // Inject Tauri mock BEFORE any navigation
    await page.addInitScript(TAURI_MOCK_SCRIPT);

    // The pre-meeting reminder (I5) is always mounted and would otherwise pop its modal over any
    // spec that happens to run within ~90s of the fixture calendar's fixed 14:00/16:00 UTC events.
    // Default it OFF here so it never contaminates unrelated specs; meeting-reminder.spec opts in.
    await page.addInitScript(() => {
      try { window.localStorage.setItem('tandem.reminder.enabled', '0'); } catch { /* ignore */ }
    });

    // Intercept direct HTTP calls to the FastAPI backend
    await page.route('**/localhost:5167/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
    );
    // Claude service endpoints
    await page.route('**/api/claude/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session_id: null }) }),
    );
    // Anonymization endpoints
    await page.route('**/api/anonymize/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: false }) }),
    );

    await use(page);
  },
});

export { expect } from '@playwright/test';
