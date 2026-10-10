/**
 * Text bound for a terminal. Author names (from the repository's own .mailmap), file paths, cap and boundary
 * names and git's error text all come from the repository being analyzed. Printed raw, an ESC, CSI or OSC
 * sequence in one of them can clear the screen, redraw a forged report or (OSC 52) write the clipboard.
 */

// C0 controls except \t (0x09) and \n (0x0a), DEL, and the C1 controls U+0080-U+009F (U+009B is a one-byte CSI).
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const visible = (c: string) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;

/** `s` with every control character except \n and \t written out as a visible `\xNN` escape. */
export function escapeControls(s: string): string {
  return s.replace(CONTROL, visible);
}

/**
 * `text` for the terminal: every control character except \n and \t escaped, except the exact SGR colour
 * sequences in `allowed` (the ones the renderer itself adds). Any other ESC sequence loses its ESC and prints
 * as text.
 */
export function terminalSafe(text: string, allowed: ReadonlySet<string>): string {
  return text.replace(/\x1b\[[0-9;]*m|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (m) => (m.length > 1 && allowed.has(m) ? m : visible(m[0]!) + m.slice(1)));
}
