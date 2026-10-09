// Plotly 3.7 does not expose polygon offset in its trace schema. Keep this
// renderer adapter isolated: bias raster depth, never physical coordinates.
const patched = new WeakSet<object>();
export function applyDepthLayers(element: any) {
  const scene = element._fullLayout?.scene?._scene;
  if (!scene?.glplot || !scene.traces) return;
  const gl = scene.glplot.gl as WebGLRenderingContext;
  for (const trace of Object.values(scene.traces) as any[]) {
    for (const object of [trace.linePlot, trace.scatterPlot]) {
      if (!object || patched.has(object)) continue;
      patched.add(object);
      for (const method of ["draw", "drawTransparent", "drawPick"]) {
        const draw = object[method];
        if (typeof draw !== "function") continue;
        object[method] = function (...args: any[]) {
          if (trace.data?.meta?.exportRole === "boundingBox" &&
              !(object._exportVisible ?? trace.data.meta.interactiveVisible)) return;
          const layer = trace.data?.meta?.depthLayer;
          if (!layer) return draw.apply(this, args);
          const enabled = gl.isEnabled(gl.POLYGON_OFFSET_FILL);
          const factor = gl.getParameter(gl.POLYGON_OFFSET_FACTOR);
          const units = gl.getParameter(gl.POLYGON_OFFSET_UNITS);
          gl.enable(gl.POLYGON_OFFSET_FILL);
          gl.polygonOffset(-layer, -4 * layer);
          try {
            return draw.apply(this, args);
          } finally {
            gl.polygonOffset(factor, units);
            if (!enabled) gl.disable(gl.POLYGON_OFFSET_FILL);
          }
        };
      }
    }
  }
  scene.glplot.redraw();
}
