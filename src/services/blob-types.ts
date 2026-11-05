// Shared types for the CV tracking pipeline. Extracted so pure helpers can
// import the Blob shape without pulling in the full TrackingService module.

export interface Blob {
  color: 'teal' | 'red';
  pixels: number;
  cx: number;
  cy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** pixels / bbox_area — low for rings, high for filled shapes */
  fillRatio: number;
}
