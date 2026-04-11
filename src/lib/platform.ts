// Tiny platform detector for UI labels only. The Rust side owns actual
// platform dispatch via cfg(target_os); this is strictly for showing the
// right word to the user.
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const isWindows =
  typeof navigator !== 'undefined' && /Win/.test(navigator.platform);

export function fileManagerLabel(): string {
  if (isMac) return 'Open in Finder';
  if (isWindows) return 'Open in Explorer';
  return 'Open file manager';
}
