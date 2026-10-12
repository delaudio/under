/** OpenTUI 0.6.1's VT reports support for in-band resize notifications (2048)
 * but does not deliver them on resize. Neovim then stops listening to SIGWINCH.
 * Report that mode as unsupported until the embedded VT implements its events.
 * Apply only to terminal-generated responses, never user input or PTY output.
 */
export function terminalResponse(bytes: Uint8Array): Uint8Array {
  const response = new TextDecoder().decode(bytes);
  const corrected = response.replace(
    /\x1b\[\?2048;[1-4]\$y/g,
    "\x1b[?2048;0$y",
  );
  return corrected === response ? bytes : new TextEncoder().encode(corrected);
}
