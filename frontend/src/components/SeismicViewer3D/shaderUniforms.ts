/** The pinned gl-shader uniform getters do not bind their GL arguments.
 * Read the active program through WebGL instead; native drawing only uses
 * uniform setters. Cache locations per program, including font recompiles. */
const locations = new WeakMap<object, Map<string, WebGLUniformLocation | null>>();
export function readShaderUniforms(shader: any, names: string[]) {
  const gl = shader?.gl as WebGLRenderingContext | undefined;
  const program = shader?.program as WebGLProgram | undefined;
  if (!gl?.getUniform || !program) return shader?.uniforms || {};
  let known = locations.get(program);
  if (!known) { known = new Map(); locations.set(program, known); }
  return Object.fromEntries(names.map(name => {
    if (!known!.has(name)) known!.set(name, gl.getUniformLocation(program, name));
    const location = known!.get(name)!;
    return [name, location === null ? null : gl.getUniform(program, location)];
  }));
}
