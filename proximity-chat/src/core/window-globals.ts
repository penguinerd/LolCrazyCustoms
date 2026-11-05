// Typed declarations for app-specific properties we hang off the global
// `window` object as an ad-hoc cross-module bus. Import this module (for its
// side effect of augmenting the `Window` interface) from anywhere those
// properties are read or written.
//
// Why a window-bus at all: the overlay and background modules are loaded as
// separate <script> tags into the same WebView, but the build emits them as
// separate webpack entry points — they can't see each other's exports
// directly. Stashing values on `window` is the lowest-overhead way to bridge
// them without standing up a real event bus or Tauri-event indirection.
//
// If this list grows past ~4 entries, that's a signal the design needs a
// proper bus (e.g. a typed singleton or Tauri emit/listen). Today it's worth
// the typing here just to catch typos in the property names.

declare global {
  interface Window {
    /**
     * Set by overlay.ts; read by background.ts on launch when the user has
     * Auto-update enabled. Triggers an immediate update check + apply.
     */
    __proxchatRunUpdateCheck?: (triggeredByUser: boolean) => Promise<void>;

    /**
     * Set by overlay.ts whenever the Debug toggle flips; read by orchestrator.ts
     * before emitting `scanner:scene` so the scanner only renders debug visuals
     * while Debug is on.
     */
    __lolproxchat_debug_enabled?: boolean;
  }
}

// Module marker — needed so TS treats this file as a module (otherwise the
// `declare global` block leaks into ambient global scope).
export {};
