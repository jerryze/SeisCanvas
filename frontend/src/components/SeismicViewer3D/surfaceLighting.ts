/** Lighting adapter for the pinned Plotly 3.7 mesh renderer. */
const patched = new WeakSet<object>();

export function surfaceLightingVertexSource(source: string) {
  // gl-mesh3d unprojects lights into object coordinates, but its shader mixes
  // those with view-space vertices and world-space normals. Use world space
  // for every lighting vector; the geometry's projection stays unchanged.
  const replacements = [
    [
      "vec4 cameraCoordinate = view * vec4(position , 1.0);",
      "vec4 cameraCoordinate = model * vec4(position, 1.0);",
    ],
    [
      "f_lightDirection = lightPosition - cameraCoordinate.xyz;",
      "f_lightDirection = (model * vec4(lightPosition, 1.0)).xyz - cameraCoordinate.xyz;",
    ],
    [
      "f_eyeDirection   = eyePosition - cameraCoordinate.xyz;",
      "f_eyeDirection = (model * vec4(eyePosition, 1.0)).xyz - cameraCoordinate.xyz;",
    ],
    [
      "f_normal  = normalize((vec4(normal, 0.0) * inverseModel).xyz);",
      // gl-mesh3d reverses triangle packing and flips front-facing normals.
      // A mirrored axis (TWT increases downward) reverses that convention.
      "float orientation = sign(dot(cross(model[0].xyz, model[1].xyz), model[2].xyz));\n" +
        "  f_normal = orientation * normalize((vec4(normal, 0.0) * inverseModel).xyz);",
    ],
  ];
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error("Unsupported Plotly mesh lighting shader.");
    source = source.replace(before, after);
  }
  return source;
}

/** Install once per shader, before the scene's next redraw. Export reuses it. */
export function applySurfaceLighting(element: any) {
  const scene = element._fullLayout?.scene?._scene;
  if (!scene?.glplot || !scene.traces) return;
  const gl = scene.glplot.gl as WebGLRenderingContext;
  for (const trace of Object.values(scene.traces) as any[]) {
    const shader = trace.mesh?.triShader;
    if (!shader || patched.has(shader)) continue;
    const vertex = gl.getShaderSource(shader.vertShader);
    const fragment = gl.getShaderSource(shader.fragShader);
    if (!vertex || !fragment) throw new Error("Plotly mesh lighting shader is unavailable.");
    // Keep VAO attribute locations and all existing geometry/texture buffers.
    const attributes = Object.entries(shader.attributes).map(([name, attribute]) => ({
      name,
      type: shader.types.attributes[name],
      location: (attribute as { location: number }).location,
    }));
    shader.update(surfaceLightingVertexSource(vertex), fragment, undefined, attributes);
    patched.add(shader);
  }
}
