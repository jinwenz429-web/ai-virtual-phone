/** WebViews may expose Clipboard API but reject writes. Only report real success. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Try the legacy WebView path. */ }
  const active = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    return document.execCommand("copy") === true;
  } catch { return false; }
  finally { area.remove(); active?.focus?.(); }
}
