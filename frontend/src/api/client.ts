/** Project identity and ordered writes are shared by all API consumers. */
export class ApiError extends Error {
  constructor(message: string, public code = "", public detail?: any) { super(message); }
}
export type ApiProject = { project_id: string | null; activation_epoch?: string; revision: number };
let context: ApiProject = { project_id: null, activation_epoch: "", revision: 0 };
let writes: Promise<unknown> = Promise.resolve();
export const getApiProject = () => context;
export function setApiProject(project: ApiProject) { context = { project_id: project.project_id, activation_epoch: project.activation_epoch || "", revision: project.revision }; }
export async function waitForMutations() { await writes; }

export async function apiError(response: Response, fallback?: string): Promise<ApiError> {
  const body = await response.json().catch(() => ({ detail: response.statusText }));
  const detail = body?.detail;
  return new ApiError(typeof detail === "string" ? detail : detail?.message || fallback || response.statusText,
    typeof detail === "object" ? detail?.code || "" : "", detail);
}

const readPost = /^\/(section|sample|scene|horizon-map(?:\/profile|\/export)?|export(?:\/3d|\/map-name|\/name)?)$/;
export async function api(path: string, init?: RequestInit & { onRevision?: (revision: number) => void }, errorFallback?: string): Promise<Response> {
  const owner = context;
  const mutation = !!init?.method && init.method !== "GET" && !readPost.test(path.split("?")[0]);
  const run = async () => {
    if (owner !== context) throw new ApiError("请求所属项目已切换。", "STALE_RESPONSE");
    const headers = new Headers(init?.headers);
    headers.set("X-SeisCanvas-Project", owner.project_id || "none");
    headers.set("X-SeisCanvas-Epoch", owner.activation_epoch || "");
    if (mutation && owner.project_id) headers.set("X-SeisCanvas-Revision", String(owner.revision));
    // State saves and structural writes share a queue and one revision cursor.
    let body = init?.body;
    if (path === "/workspace" && init?.method === "PUT" && typeof body === "string") {
      body = JSON.stringify({ ...JSON.parse(body), revision: owner.revision });
    }
    const { onRevision, ...request } = init || {};
    onRevision?.(owner.revision);
    const r = await fetch("/api" + path, { ...request, body, headers });
    if (owner !== context) throw new ApiError("请求所属项目已切换。", "STALE_RESPONSE");
    if (!r.ok) {
      const error = await apiError(r, errorFallback);
      if (error.code === "PROJECT_CHANGED" || error.code === "REVISION_CONFLICT") {
        window.dispatchEvent(new CustomEvent("seiscanvas-project-conflict", { detail: error }));
      }
      throw error;
    }
    const revision = r.headers.get("X-Project-Revision");
    // Only writes advance our cursor; reads must not silently acknowledge a
    // revision committed by another browser tab.
    if (mutation && revision !== null) owner.revision = Number(revision);
    return r;
  };
  if (!mutation) return run();
  const pending = writes.then(run, run);
  writes = pending.catch(() => undefined);
  return pending;
}

export const json = (value: unknown) => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

export function projectFileUrl(itemId: string, filename: string, projectId: string | null) {
  return `/api/export/queue/${encodeURIComponent(itemId)}/file?project_id=${encodeURIComponent(projectId || "none")}&v=${encodeURIComponent(filename)}`;
}
