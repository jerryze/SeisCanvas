/** Measure actual rendered pixels, including WebGL axis text, without treating
 * white seismic samples as whitespace. Always measure a transparent capture. */
export function contentBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  padding = 8,
) {
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 0) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  if (x1 < 0) throw new Error("场景没有可导出的可见内容。");
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
