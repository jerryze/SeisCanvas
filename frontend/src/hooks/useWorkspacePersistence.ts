import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, getApiProject, json } from "../api/client";
import { WorkspaceState, draftKey, draftTabId } from "../workspace";

type Status = "idle" | "dirty" | "saving" | "saved" | "error";

/** One serial writer, an awaitable flush, and a draft owned by this project/tab. */
export function useWorkspacePersistence(
  state: WorkspaceState,
  project: { project_id: string | null; revision: number; state?: WorkspaceState | null; issues: unknown[] } | null,
  ready: boolean,
  onError: (message: string) => void,
) {
  const [status, setStatus] = useState<Status>("idle");
  const [draftWarning, setDraftWarning] = useState("");
  const session = useRef({ id: "", saved: "", latest: "", inflight: "", paused: false, blocked: false,
    alive: true, revision: 0, tab: draftTabId(), running: null as Promise<void> | null });
  const failure = useRef(onError);
  failure.current = onError;
  const writeDraft = useCallback(() => {
    const s = session.current;
    if (!s.id || !s.latest || !s.alive) return;
    if (!s.inflight && getApiProject().project_id === s.id) s.revision = getApiProject().revision;
    try {
      if (!s.inflight && s.latest === s.saved) {
        localStorage.removeItem(draftKey(s.id, s.tab));
        return;
      }
      localStorage.setItem(draftKey(s.id, s.tab), JSON.stringify({ version: 1, project_id: s.id,
        revision: s.revision, updated_at: new Date().toISOString(), state: JSON.parse(s.latest), inflight: s.inflight ? JSON.parse(s.inflight) : null }));
    } catch { setDraftWarning("草稿保存失败。"); }
  }, []);

  // Capture the latest committed render before a Save/Switch click can flush.
  useLayoutEffect(() => {
    if (!ready || !project?.project_id || project.issues.length) return;
    const s = session.current;
    if (s.id !== project.project_id) {
      s.id = project.project_id;
      s.revision = project.revision;
      s.saved = project.state ? JSON.stringify(project.state) : "";
    }
    s.latest = JSON.stringify(state);
    writeDraft();
    if (!s.running) setStatus(s.latest === s.saved ? "saved" : "dirty");
  }, [state, project, ready, writeDraft]);

  const flush = useCallback(async () => {
    const s = session.current;
    if (!s.id) return getApiProject().revision;
    if (s.blocked) throw new Error("项目已更新，请重新加载。");
    if (!s.running) {
      s.running = (async () => {
        try {
          while (s.alive && s.latest !== s.saved) {
            const body = s.latest;
            s.inflight = body;
            s.revision = getApiProject().revision;
            writeDraft();
            setStatus("saving");
            const r = await api("/workspace", { ...json({ project_id: s.id, revision: s.revision, state: JSON.parse(body) }), method: "PUT",
              onRevision: revision => { s.revision = revision; writeDraft(); },
            });
            const result = await r.json();
            s.revision = result.revision;
            s.saved = body;
            s.inflight = "";
            writeDraft();
          }
          if (s.alive) setStatus("saved");
        } catch (error) {
          if (s.alive) {
            setStatus("error");
            s.blocked = error instanceof ApiError && ["PROJECT_CHANGED", "REVISION_CONFLICT"].includes(error.code);
            failure.current("保存失败：" + (error as Error).message);
          }
          throw error;
        }
      })().finally(() => { s.running = null; });
    }
    await s.running;
    return s.revision;
  }, [writeDraft]);

  useEffect(() => {
    if (!ready || session.current.paused || !session.current.id || session.current.blocked || session.current.saved === session.current.latest) return;
    const timer = setTimeout(() => { if (!session.current.paused) void flush().catch(() => undefined); }, 500);
    return () => clearTimeout(timer);
  }, [state, project, ready, flush]);

  useEffect(() => {
    const s = session.current;
    s.alive = true;
    const hidden = () => {
      writeDraft();
      if (!s.paused) void flush().catch(() => undefined);
    };
    const visibility = () => { if (document.visibilityState === "hidden") hidden(); };
    window.addEventListener("pagehide", hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      s.alive = false;
      window.removeEventListener("pagehide", hidden);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [flush, writeDraft]);
  return { status, draftWarning, flush,
    pause: () => { session.current.paused = true; },
    resume: () => { session.current.paused = false; },
  };
}
