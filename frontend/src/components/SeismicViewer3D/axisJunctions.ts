/** Plotly 3.7 gl-axes3d adapter: suppress only colliding endpoint glyphs.
 * Native tick positions, middle labels, titles and tick marks stay untouched. */
type Point = [number, number];
type Box = { left: number; right: number; top: number; bottom: number };
type Endpoint = { axis: number; corner: number; box: Box };

export function overlapsAtJunction(a: Endpoint, b: Endpoint) {
  return (
    a.axis !== b.axis &&
    a.corner === b.corner &&
    a.box.left < b.box.right &&
    b.box.left < a.box.right &&
    a.box.top < b.box.bottom &&
    b.box.top < a.box.bottom
  );
}

function project(point: number[], uniforms: any): Point {
  let v = [...point, 1];
  for (const matrix of [uniforms.model, uniforms.view, uniforms.projection])
    v = [0, 1, 2, 3].map((r) =>
      v.reduce((sum, n, c) => sum + matrix[c * 4 + r] * n, 0),
    );
  const w = Math.max(v[3], 0.0001); // Same perspective divide as the text shader.
  return [
    ((v[0] / w + 1) * uniforms.resolution[0]) / 2,
    ((1 - v[1] / w) * uniforms.resolution[1]) / 2,
  ];
}

/** Mirror gl-axes3d's text shader alignment so collision bounds use the
 * existing glyph geometry, including font, size and text rotation. */
function textAngle(
  point: number[],
  axis: number[],
  alignDir: number[],
  opt: number[],
  angle: number,
  uniforms: any,
) {
  if (!opt[2]) return angle;
  const origin = project(point, uniforms);
  const direction = (d: number[]) => {
    const end = project(
      point.map((v, i) => v + d[i]),
      uniforms,
    );
    let a = Math.atan2(origin[1] - end[1], end[0] - origin[0]);
    if (Math.sin(a) < 0) a += Math.PI;
    return a;
  };
  const a = direction(axis),
    b = direction(alignDir);
  const flip =
    Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) > 0 ? Math.PI : 0;
  const option = Math.floor(opt[0] + 0.001);
  const positive = (n: number) => ((n % Math.PI) + Math.PI) % Math.PI;
  const upright = (n: number) => {
    const p = positive(n);
    return p > Math.PI / 2 ? p - Math.PI : p;
  };
  if (option === -1) return angle;
  if (option === 0) return angle + upright(b);
  if (option === 1) return angle + b + flip;
  if (option === 2) {
    const p = positive(b + flip),
      ratio = opt[1];
    return (
      angle +
      (p < (ratio * Math.PI) / 2
        ? 0
        : p < ((2 - ratio) * Math.PI) / 2
          ? -Math.PI / 2
          : 0)
    );
  }
  const step = (2 * Math.PI) / option;
  return (
    angle + upright(step * Math.floor((positive(b + flip) + step / 2) / step))
  );
}

/** Install before axes.update builds export fonts. Reads its existing text
 * vertex upload, then omits only one side of a corner overlap at draw time.
 * No ticks are removed from the renderer or rebuilt for collision handling. */
export function suppressJunctionOverlaps(axes: any): () => void {
  const text = axes?._text;
  if (!text?.buffer?.update || !text.bind || !text.drawTicks) return () => {};
  const upload = text.buffer.update,
    bind = text.bind,
    draw = text.drawTicks;
  let vertices: number[] = [];
  let accepted: Endpoint[] = [];
  let uniforms: any;
  text.buffer.update = function (data: ArrayLike<number>, ...args: any[]) {
    vertices = Array.from(data);
    return upload.call(this, data, ...args);
  };
  text.bind = function (...args: any[]) {
    accepted = [];
    uniforms = {
      model: args[0],
      view: args[1],
      projection: args[2],
      pixelScale: args[3],
      resolution: [this.gl.drawingBufferWidth, this.gl.drawingBufferHeight],
    };
    return bind.apply(this, args);
  };
  text.drawTicks = function (
    axis: number,
    size: number,
    angle: number,
    offset: number[],
    color: number[],
    direction: number[],
    alignDir: number[],
    opt: number[],
  ) {
    const args = [axis, size, angle, offset, color, direction, alignDir, opt];
    const start = this.tickOffset[axis],
      count = this.tickCount[axis];
    if (!vertices.length || !count || !uniforms) return draw.apply(this, args);
    // Each glyph vertex stores the tick coordinate in its third component.
    const groups: { start: number; end: number; x: number }[] = [];
    for (let i = start; i < start + count; i++) {
      const x = vertices[i * 3 + 2];
      const last = groups[groups.length - 1];
      if (last?.x === x) last.end = i + 1;
      else groups.push({ start: i, end: i + 1, x });
    }
    if (groups.length < 2) return draw.apply(this, args);
    const hidden: typeof groups = [];
    for (const group of [groups[0], groups[groups.length - 1]]) {
      const side =
        Math.abs(group.x - axes.bounds[0][axis]) <=
        Math.abs(group.x - axes.bounds[1][axis])
          ? 0
          : 1;
      const corner =
        (axes.lastCubeProps.cubeEdges[axis] & ~(1 << axis)) | (side << axis);
      const point = offset.map((v, i) => v + group.x * direction[i]);
      const origin = project(point, uniforms);
      const beta = textAngle(point, direction, alignDir, opt, angle, uniforms);
      const scale = size * uniforms.pixelScale;
      const box: Box = {
        left: Infinity,
        right: -Infinity,
        top: Infinity,
        bottom: -Infinity,
      };
      for (let i = group.start; i < group.end; i++) {
        const x = vertices[i * 3],
          y = vertices[i * 3 + 1];
        const px =
          origin[0] + scale * (Math.cos(beta) * x - Math.sin(beta) * y);
        const py =
          origin[1] - scale * (Math.sin(beta) * x + Math.cos(beta) * y);
        box.left = Math.min(box.left, px);
        box.right = Math.max(box.right, px);
        box.top = Math.min(box.top, py);
        box.bottom = Math.max(box.bottom, py);
      }
      const endpoint = { axis, corner, box };
      if (accepted.some((other) => overlapsAtJunction(endpoint, other)))
        hidden.push(group);
      else accepted.push(endpoint);
    }
    if (!hidden.length) return draw.apply(this, args);
    // Keep every vertex outside a hidden endpoint, including all middle ticks.
    let cursor = start;
    try {
      for (const group of [
        ...hidden,
        { start: start + count, end: start + count, x: 0 },
      ]) {
        this.tickOffset[axis] = cursor;
        this.tickCount[axis] = group.start - cursor;
        if (this.tickCount[axis]) draw.apply(this, args);
        cursor = group.end;
      }
    } finally {
      this.tickOffset[axis] = start;
      this.tickCount[axis] = count;
    }
  };
  return () => {
    text.buffer.update = upload;
    text.bind = bind;
    text.drawTicks = draw;
  };
}
