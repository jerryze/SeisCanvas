/** Measure actual rendered pixels, including WebGL axis text, without treating
 * white seismic samples as whitespace. Always measure a transparent capture. */
export function contentBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  padding = 8,
  vectorPoints: readonly (readonly number[])[] = [],
) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 0) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  for (const point of vectorPoints) {
    if (!point.every(Number.isFinite)) continue;
    x0 = Math.min(x0, Math.floor(point[0]));
    y0 = Math.min(y0, Math.floor(point[1]));
    x1 = Math.max(x1, Math.ceil(point[0]));
    y1 = Math.max(y1, Math.ceil(point[1]));
  }
  if (!Number.isFinite(x1)) throw new Error("场景没有可导出的可见内容。");
  return {
    x: x0 - padding,
    y: y0 - padding,
    width: x1 - x0 + 1 + padding * 2,
    height: y1 - y0 + 1 + padding * 2,
  };
}

export async function imageCanvas(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建导出画布。");
  context.drawImage(image, 0, 0);
  return { canvas, context };
}
