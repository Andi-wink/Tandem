import { toast } from 'sonner';

/**
 * Post-start recording confirmation.
 *
 * This used to be the *only* consent-adjacent surface in the app: a toast fired after the backend
 * had already started, telling the user to "Inform all participants", with an acknowledgement
 * button whose click was never persisted and a 10-second auto-dismiss. That is the wrong order
 * (§ 201 Abs. 1 Nr. 1 StGB is complete at the moment of fixation, so a notice afterwards does not
 * cure it) and the wrong artefact (GDPR Art 7(1) needs provable consent, not a dismissed toast).
 *
 * Consent is now collected and logged *before* capture by the pre-record gate
 * (`ConsentDialog` + `src-tauri/src/consent.rs`). What remains here is what a toast is actually
 * good for: confirming that recording is live and that the consent record was written.
 *
 * @returns Promise<void> - Resolves when the confirmation is shown or skipped
 */
export async function showRecordingNotification(): Promise<void> {
  try {
    const { Store } = await import('@tauri-apps/plugin-store');
    const store = await Store.load('preferences.json');
    const showNotification = (await store.get<boolean>('show_recording_notification')) ?? true;

    if (!showNotification) return;

    toast.success('🔴 Recording', {
      description: 'Consent logged. Recording and transcribing.',
      duration: 4000,
      position: 'bottom-right',
    });
  } catch (notificationError) {
    console.error('Failed to show recording notification:', notificationError);
    // Don't fail the recording if the confirmation fails
  }
}
