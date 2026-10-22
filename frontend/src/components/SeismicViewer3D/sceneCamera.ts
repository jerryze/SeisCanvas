import type { Camera } from "../../types";

/** Plotly changes property order and introduces round-off when reading a live
 * camera. Compare its values, so an unchanged camera never becomes a preset. */
export function sceneCameraKey(camera: Camera): string {
  const vector = (v: Camera["eye"]) => [v.x, v.y, v.z].map(n => Math.round(n * 1e9) / 1e9);
  return JSON.stringify([vector(camera.eye), vector(camera.center), vector(camera.up),
    camera.projection?.type || "perspective"]);
}
