/**
 * OS-level notification for agent output in Solo Mode.
 *
 * Solo Mode's whole premise is that the user is talking and working elsewhere,
 * not watching Tandem. An in-app sonner toast in a background window is
 * therefore invisible by construction: it is shown, times out, and the user
 * never learns the agent finished. A native notification reaches him in the
 * editor.
 *
 * Best-effort by design: permission denied, plugin unavailable or an OS that
 * silently drops notifications must never break the routing loop, so every
 * failure is swallowed after a console warning. The toast and `responses.md`
 * archive remain the durable paths.
 */

const MAX_BODY_CHARS = 240;

/** Trim a reply to a notification-sized preview without cutting mid-word. */
export function previewForNotification(content: string, max = MAX_BODY_CHARS): string {
  const flat = content.trim().replace(/\s+/g, ' ');
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Fire a native notification for one agent reply. Never throws and never
 * blocks: callers can treat it as fire-and-forget.
 */
export function notifyAgentResponse(projectName: string, content: string): void {
  void (async () => {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import('@tauri-apps/plugin-notification');

      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === 'granted';
      }
      if (!granted) return;

      sendNotification({
        title: `Tandem — ${projectName}`,
        body: previewForNotification(content),
      });
    } catch (err) {
      console.warn('[SoloRouter] OS notification unavailable:', err);
    }
  })();
}
