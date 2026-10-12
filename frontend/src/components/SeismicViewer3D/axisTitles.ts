/** Plotly 3.7 does not expose 3D title rotation. Add half a turn to the
 * native Time title drawing angle, preserving its camera-dependent alignment. */
const rotated = new WeakSet<object>();
export function applyTimeAxisTitleRotation(axes: any) {
  const text = axes?._text;
  if (!text?.drawLabel || rotated.has(text)) return;
  const drawLabel = text.drawLabel;
  text.drawLabel = function (axis: number, size: number, angle: number, ...args: any[]) {
    return drawLabel.call(this, axis, size, angle + (axis === 2 ? Math.PI : 0), ...args);
  };
  rotated.add(text);
}
