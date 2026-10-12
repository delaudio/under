import type { CliRenderer } from "@opentui/core";

/** OpenTUI 0.6.1 has no public full-repaint API. Keep the compatibility shim here.
 * Embedded hosts can lose cursor advancement during incremental output (#1187).
 * Used only for the explicit Redraw terminals action, not every frame.
 * Remove when the pinned renderer provides a corrected emitter/public API.
 */
export function repaint(renderer: CliRenderer) {
  const emitter = renderer as unknown as { forceFullRepaintRequested: boolean };
  if (!("forceFullRepaintRequested" in emitter))
    throw new Error(
      "OpenTUI repaint compatibility changed; update Under's renderer adapter",
    );
  emitter.forceFullRepaintRequested = true;
  renderer.requestRender();
}
