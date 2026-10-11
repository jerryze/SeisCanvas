import { useEffect, useRef, useState } from "react";
import { api, json } from "../api/client";
import { WorkspaceState, DRAFT_KEY } from "../workspace";

type Status = "idle" | "saving" | "saved" | "error";

/** Serial saves keep revisions ordered; a local draft covers a quick refresh. */
export function useWorkspacePersistence(
  state: WorkspaceState,
  project: { project_id: string | null; revision: number; issues: unknown[] } | null,
  ready: boolean,
  onError: (message: string) => void,
) {
  const [status, setStatus] = useState<Status>("idle");
  const current = useRef({ id: "", revision: 0, saved: "", latest: "", inflight: "", running: false, blocked: false });
  const failure = useRef(onError);
  failure.current = onError;

  useEffect(() => {
    if (!ready || !project?.project_id || project.issues.length) return;
    if (current.current.id !== project.project_id) {
      current.current = { id: project.project_id, revision: project.revision, saved: "", latest: "", inflight: "", running: false, blocked: false };
    }
    const session = current.current;
    const encoded = JSON.stringify(state);
    session.latest = encoded;
    const writeDraft = () => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, project_id: session.id, revision: session.revision, state: JSON.parse(session.latest), inflight: session.inflight ? JSON.parse(session.inflight) : null }));
      } catch { /* Server persistence still works if browser storage is disabled. */ }
    };
    writeDraft();
    if (encoded === session.saved || session.blocked) return;
    setStatus("saving");
    const save = async () => {
      if (session.running || session.blocked || current.current !== session) return;
      session.running = true;
      try {
        while (session.saved !== session.latest && current.current === session) {
          const body = session.latest;
          session.inflight = body;
          writeDraft();
          const r = await api("/workspace", {
            ...json({ project_id: session.id, revision: session.revision, state: JSON.parse(body) }), method: "PUT",
          });
          const result = await r.json();
          session.revision = result.revision;
          session.saved = body;
          session.inflight = "";
          if (current.current === session) writeDraft();
        }
        if (current.current === session) setStatus("saved");
      } catch (e) {
        if (current.current === session) {
          setStatus("error");
          failure.current("自动保存失败：" + (e as Error).message);
          // A conflict requires explicit restoration, not an automatic retry.
          session.blocked = (e as Error).message.includes("刷新页面") || (e as Error).message.includes("完整恢复");
        }
      } finally {
        session.running = false;
      }
    };
    const timer = setTimeout(save, 500);
    const flush = () => { writeDraft(); void save(); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [state, project, ready]);
  return status;
}
