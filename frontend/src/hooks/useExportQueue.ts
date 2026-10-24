import { useCallback, useEffect, useRef, useState } from "react";
import type { ExportRestore } from "../exportRestore";
import type { ExportItem, ExportJob } from "../types";
import { api, ApiError, getApiProject, json } from "../api/client";

type Task = (label: string, fn: () => Promise<void>) => Promise<void>;
const activeJob = (job: ExportJob) => job.status === "queued" || job.status === "running";
const ignoredError = (error: unknown) => (error as Error)?.name === "AbortError"
  || (error as ApiError)?.code === "STALE_RESPONSE";
const projectConflict = (error: unknown) => ["PROJECT_CHANGED", "REVISION_CONFLICT"].includes((error as ApiError)?.code);

/** Saved figures and their background generation jobs belong to this mounted project. */
export function useExportQueue(opts: {
  task: Task;
  notify: (message: string) => void;
  onError: (message: string) => void;
}) {
  const callbacks = useRef(opts);
  callbacks.current = opts;
  const owner = useRef(getApiProject());
  const alive = useRef(false);
  const generation = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const refreshSequence = useRef(0);
  const jobMutation = useRef(0);
  const knownJobs = useRef(new Map<string, string>());
  const jobsRef = useRef<ExportJob[]>([]);
  const pollNow = useRef<() => void>(() => {});
  const stopPolling = useRef(false);
  const submissionPending = useRef(false);
  const actionsPending = useRef(new Set<string>());
  const [items, setItems] = useState<ExportItem[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pendingJobIds, setPendingJobIds] = useState<Set<string>>(new Set());

  const begin = useCallback(() => {
    const controller = new AbortController(), epoch = generation.current;
    requests.current.add(controller);
    return {
      controller,
      current: () => alive.current && !controller.signal.aborted && epoch === generation.current
        && owner.current === getApiProject(),
      finish: () => requests.current.delete(controller),
    };
  }, []);

  const refresh = useCallback(async () => {
    const request = begin(), sequence = ++refreshSequence.current;
    try {
      const r = await api("/export/queue", { signal: request.controller.signal });
      const data = await r.json();
      if (!request.current() || sequence !== refreshSequence.current) return;
      setItems(data.items || []);
      setSessionId(data.session || "");
    } catch (e) {
      if (request.current() && !ignoredError(e)) {
        if (projectConflict(e)) stopPolling.current = true;
        callbacks.current.onError((e as Error).message);
      }
    } finally {
      request.finish();
    }
  }, [begin]);

  const acceptJobs = useCallback((next: ExportJob[], announce = true) => {
    let completed = false;
    for (const job of next) {
      const key = `${job.status}:${job.attempts || 1}`;
      const previous = knownJobs.current.get(job.id);
      if (previous !== key) {
        if (job.status === "completed") {
          completed = true;
          if (announce || previous !== undefined) callbacks.current.notify(`已保存图件\n${job.item?.filename || job.label}`);
        } else if (job.status === "failed" && (announce || previous !== undefined)) {
          callbacks.current.notify(`图件生成失败，可在导出队列重试\n${job.label}`);
        }
        knownJobs.current.set(job.id, key);
      }
    }
    jobsRef.current = next;
    setJobs(next);
    if (completed) void refresh();
  }, [refresh]);

  useEffect(() => {
    alive.current = true;
    generation.current += 1;
    stopPolling.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false, pollAgain = false, initial = true, lastError = "";
    let pollController: AbortController | undefined;
    const epoch = generation.current;
    const current = () => alive.current && generation.current === epoch && owner.current === getApiProject();
    const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const poll = async () => {
      if (!current() || stopPolling.current || document.hidden || polling) return;
      clearTimer();
      polling = true;
      const request = begin(), mutation = jobMutation.current;
      pollController = request.controller;
      try {
        const r = await api("/export/jobs", { signal: request.controller.signal });
        const data: { jobs: ExportJob[] } = await r.json();
        // A poll can observe a completed job before its POST body is parsed.
        // Wait for the mutation acknowledgement so a queued acknowledgement
        // cannot overwrite that newer terminal state or announce it twice.
        if (!request.current() || mutation !== jobMutation.current
          || submissionPending.current || actionsPending.current.size > 0) return;
        acceptJobs(data.jobs || [], !initial);
        initial = false;
        lastError = "";
      } catch (e) {
        if (request.current() && !ignoredError(e)) {
          if (projectConflict(e)) stopPolling.current = true;
          const message = (e as Error).message;
          if (message !== lastError) callbacks.current.onError(message);
          lastError = message;
        }
      } finally {
        request.finish();
        polling = false;
        pollController = undefined;
        if (current() && !stopPolling.current && !document.hidden) {
          // Failed requests back off; they must not turn into a fast error loop.
          const delay = pollAgain ? 0 : lastError ? 5000 : jobsRef.current.some(activeJob) ? 1000 : 5000;
          pollAgain = false;
          timer = setTimeout(poll, delay);
        }
      }
    };
    const kick = () => {
      clearTimer();
      if (polling) pollAgain = true;
      else void poll();
    };
    const visibility = () => {
      if (document.hidden) { clearTimer(); pollController?.abort(); }
      else kick();
    };
    pollNow.current = kick;
    void refresh();
    void poll();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false;
      generation.current += 1;
      clearTimer();
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
      pollNow.current = () => {};
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [acceptJobs, begin, refresh]);

  /** Submit only the fixed export request; rendering never occupies the global task overlay. */
  const submitJob = useCallback(async (body: Record<string, unknown>) => {
    if (submissionPending.current) return;
    submissionPending.current = true;
    setSubmitting(true);
    const request = begin();
    try {
      const r = await api("/export/jobs", { ...json(body), signal: request.controller.signal });
      const job: ExportJob = await r.json();
      if (!request.current()) return;
      jobMutation.current += 1;
      acceptJobs([job, ...jobsRef.current.filter(value => value.id !== job.id)]);
      callbacks.current.notify("已加入导出任务，可继续浏览");
      pollNow.current();
      return job;
    } catch (e) {
      if (request.current() && !ignoredError(e)) {
        if (projectConflict(e)) stopPolling.current = true;
        callbacks.current.onError((e as Error).message);
        throw e;
      }
    } finally {
      request.finish();
      submissionPending.current = false;
      if (request.current()) setSubmitting(false);
    }
  }, [acceptJobs, begin]);

  const changeJob = useCallback(async (job: ExportJob, action: "cancel" | "retry") => {
    if (actionsPending.current.has(job.id)) return;
    actionsPending.current.add(job.id);
    setPendingJobIds(new Set(actionsPending.current));
    const request = begin();
    try {
      const r = await api(`/export/jobs/${encodeURIComponent(job.id)}/${action}`, {
        method: "POST", signal: request.controller.signal,
      });
      const updated: ExportJob = await r.json();
      if (!request.current()) return;
      jobMutation.current += 1;
      acceptJobs([updated, ...jobsRef.current.filter(value => value.id !== updated.id)]);
      callbacks.current.notify(action === "cancel" ? "已取消排队" : "已重新加入导出任务");
      pollNow.current();
    } catch (e) {
      if (request.current() && !ignoredError(e)) {
        if (projectConflict(e)) stopPolling.current = true;
        callbacks.current.onError((e as Error).message);
      }
    } finally {
      request.finish();
      actionsPending.current.delete(job.id);
      if (request.current()) setPendingJobIds(new Set(actionsPending.current));
    }
  }, [acceptJobs, begin]);
  const cancelJob = useCallback((job: ExportJob) => changeJob(job, "cancel"), [changeJob]);
  const retryJob = useCallback((job: ExportJob) => changeJob(job, "retry"), [changeJob]);

  /** Kept for synchronous callers until all export entry points use jobs. */
  const addItem = useCallback(async (body: Record<string, unknown>) => {
    const request = begin();
    try {
      const r = await api("/export/queue", { ...json(body), signal: request.controller.signal });
      const item: ExportItem = await r.json();
      if (!request.current()) return;
      await refresh();
      if (request.current()) callbacks.current.notify(`已保存图件\n${item.filename}`);
      return item;
    } finally { request.finish(); }
  }, [begin, refresh]);

  const rename = useCallback((item: ExportItem, filename: string) =>
    callbacks.current.task("正在重命名图件…", async () => {
      await api(`/export/queue/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename }) });
      await refresh();
    }), [refresh]);
  const remove = useCallback((item: ExportItem) =>
    callbacks.current.task("删除暂存图片…", async () => {
      await api(`/export/queue/${item.id}`, { method: "DELETE" });
      await refresh();
    }), [refresh]);
  const clear = useCallback(() => callbacks.current.task("清空导出队列…", async () => {
    await api("/export/queue", { method: "DELETE" });
    await refresh();
    if (alive.current && owner.current === getApiProject()) callbacks.current.notify("队列已清空");
  }), [refresh]);

  const exportItems = useCallback((itemIds?: string[]) => callbacks.current.task("正在打包 ZIP…", async () => {
    const request = begin();
    try {
      const r = await api("/export/archive", { ...(itemIds ? json({ item_ids: itemIds }) : { method: "POST" }), signal: request.controller.signal });
      const header = r.headers.get("X-Export-Filename");
      let name = "SeisCanvas_Export.zip";
      if (header) { try { name = decodeURIComponent(header); } catch { name = header; } }
      const blob = await r.blob();
      if (!request.current()) return;
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      callbacks.current.notify(`ZIP 已导出\n${name}`);
    } finally { request.finish(); }
  }), [begin]);

  const restoreSettings = useCallback(async (item: ExportItem, signal: AbortSignal): Promise<ExportRestore> => {
    const response = await api(`/export/queue/${encodeURIComponent(item.id)}/settings`, { signal });
    return response.json();
  }, []);

  return { items, sessionId, refresh, addItem, rename, remove, clear, exportItems, restoreSettings,
    jobs, submitting, submitJob, cancelJob, retryJob, pendingJobIds,
    activeJobCount: jobs.filter(activeJob).length };
}
