// Scanner window — the transparent overlay that sits on top of the minimap.
// CRITICAL: this window is composited into the GDI BitBlt screen-grab that feeds
// CV (capture.rs grabs the desktop DC), so ANYTHING it renders inside the
// minimap rectangle is fed back into the next capture frame. We can't hide it
// with WDA_EXCLUDEFROMCAPTURE — that broke ShadowPlay / OBS recording of the
// whole app. So the rule here is: render nothing that overlaps a champion icon.
//
// History of this trap (each instance corrupted CV until removed):
//  - The HSV-filtered debug image used to be painted here; it fed back as teal
//    and was moved to a thumbnail in the panel's Settings area.
//  - The tracked-position dot was *also* drawn here (an 8px red disc at the
//    locked position). It was assumed safe because "red is outside the teal
//    filter range" — but that misses the mechanism: the dot landed on top of
//    the champion icon every frame, OCCLUDING the teal self-ring the detector
//    keys on (and adding a spurious red/enemy blob). With Debug on this drove
//    drift, cross-map jumps and "no teal blobs" — i.e. watching the tracker via
//    the dot broke the tracker. The tracked position now renders ONLY in the
//    debug thumbnail (generateFilteredImage() in tracking.ts), a separate
//    canvas that is never captured.

import { listen } from '@tauri-apps/api/event';

const scannerRoot = document.getElementById('scanner-root')!;

interface SceneUpdate {
  // Whether the user has Debug toggled on. When false, hide all debug visuals.
  debugEnabled: boolean;
}

listen<SceneUpdate>('scanner:scene', (event) => {
  const { debugEnabled } = event.payload;

  // Red region border — calibration sanity check that the scanner is aligned to
  // the minimap. It rides the minimap's own frame (the outermost edge, outside
  // the playable area where champion icons sit), so unlike the dot it doesn't
  // occlude the self-ring. It is still captured, so keep it strictly edge-only.
  scannerRoot.style.boxShadow = debugEnabled
    ? 'inset 0 0 0 3px rgba(255, 0, 0, 0.85)'
    : '';
});

export {};
