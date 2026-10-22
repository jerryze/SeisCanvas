import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, FilePlus2, FolderOpen, LoaderCircle, Pencil, Search, X, Link2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useModalFocus } from "../hooks/useModalFocus";
import type { WorkspaceResponse } from "../workspace";
import "./projectMenu.css";

export type ProjectAction = {
  type: "create" | "clone" | "rename" | "open" | "relink";
  id?: string; name?: string; requestId?: string;
  relink?: { horizon_id: string | null; path?: string; confirm?: boolean; revision?: number; file_identity?: Record<string, string> };
  signal?: AbortSignal;
  onCommit?: () => void;
};
type ProjectEntry = {
  id: string; name: string; filename?: string | null; path?: string | null;
  horizon_count?: number; updated_at: string; status: "missing" | "unchecked" | "empty" | "damaged";
};
type Issue = { horizon_id: string | null; message: string };
type Props = { project: WorkspaceResponse | null; disabled: boolean; onAction: (action: ProjectAction) => Promise<any> };
const timeLabel = (value: string) => value ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";

export default function ProjectMenu({ project, disabled, onAction }: Props) {
  const [mode, setMode] = useState<"create" | "clone" | "rename" | "open" | null>(null);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [listing, setListing] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [repair, setRepair] = useState<{ projectId: string; issue: Issue; candidate: any } | null>(null);
  const requestId = useRef("");
  const menu = useRef<HTMLDetailsElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const close = () => { if (!pending || canCancel) { controller.current?.abort(); setMode(null); setRepair(null); setIssues([]); } };
  useModalFocus(dialog, !!mode, close, !pending || canCancel);

  async function refresh() {
    setListing(true);
    try { setProjects((await (await api("/projects")).json()).projects); }
    catch (e) { setError((e as Error).message); }
    finally { setListing(false); }
  }
  useEffect(() => { void refresh(); }, [project?.project_id]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (menu.current && !menu.current.contains(e.target as Node)) menu.current.open = false; };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && menu.current?.open) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => { if (mode && mode !== "open") nameInput.current?.select(); }, [mode]);

  function show(next: NonNullable<typeof mode>) {
    if (disabled) return;
    if (menu.current) menu.current.open = false;
    setError(""); setIssues([]); setRepair(null); setQuery("");
    setName(next === "rename" ? project?.name || "未命名项目" : next === "clone" ? `${project?.name || "未命名项目"} 副本`.slice(0, 80) : "未命名项目");
    requestId.current = crypto.randomUUID().replaceAll("-", "");
    setSelected(project?.project_id || "");
    setMode(next);
    if (next === "open") void refresh();
  }
  async function execute(action: ProjectAction) {
    if (pending) return;
    setPending(true); setError("");
    setCanCancel(["create", "clone", "open"].includes(action.type));
    controller.current = new AbortController();
    try {
      const result = await onAction({ ...action, signal: controller.current.signal, onCommit: () => setCanCancel(false) });
      if (action.type !== "relink") setMode(null);
      return result;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
      if (e instanceof ApiError && e.code === "SOURCE_ISSUES") { setIssues(e.detail.issues); setSelected(e.detail.project_id); }
      throw e;
    } finally { setPending(false); }
  }
  const chosen = projects.find(p => p.id === selected);
  const filtered = projects.filter(p => `${p.name} ${p.filename || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const openProject = (id: string) => {
    setIssues([]); setRepair(null);
    void execute({ type: "open", id }).catch(() => {
      setMode("open");
    });
  };
  async function chooseRepair(issue: Issue) {
    try {
      const candidate = await execute({ type: "relink", id: selected, relink: { horizon_id: issue.horizon_id } });
      if (candidate && !candidate.cancelled) setRepair({ projectId: selected, issue, candidate });
    } catch { /* Error is shown inside the dialog. */ }
  }

  return <>
    <details ref={menu} className={`project-switcher${disabled ? " is-disabled" : ""}`} onToggle={() => { if (menu.current?.open) void refresh(); }}>
      <summary aria-label={`项目：${project?.name || "未打开项目"}`} aria-disabled={disabled} onClick={e => { if (disabled) e.preventDefault(); }}>
        <FolderOpen size={16}/><span title={project?.name}>{project?.name || "未打开项目"}</span><ChevronDown size={13}/>
      </summary>
      <div className="project-dropdown" aria-label="项目操作">
        {project?.project_id && <>
          <button disabled={disabled} onClick={() => show("rename")}><Pencil size={14}/>重命名…</button>
          <button disabled={disabled || !!project.issues.length} onClick={() => show("clone")}><Copy size={14}/>另存为新项目…</button><hr/></>}
        <button disabled={disabled} onClick={() => show("create")}><FilePlus2 size={14}/>新建项目…</button>
        <button disabled={disabled} onClick={() => show("open")}><FolderOpen size={14}/>打开项目…</button>
        {!!projects.length && <><hr/><p>最近项目</p>{projects.slice(0, 5).map(p => <button key={p.id} disabled={disabled || p.id === project?.project_id || p.status === "damaged"} onClick={() => { if (menu.current) menu.current.open = false; setSelected(p.id); setMode("open"); openProject(p.id); }}>
          {p.id === project?.project_id ? <Check size={14}/> : <span className="project-icon-space"/>}<span>{p.name}</span><small>{p.id === project?.project_id ? "当前" : p.status === "missing" ? "文件缺失" : timeLabel(p.updated_at)}</small>
        </button>)}</>}
      </div>
    </details>
    {mode && <div className="modal-backdrop project-backdrop" onClick={close}>
      <div className={`modal project-dialog${mode === "open" ? " project-browser" : ""}`} ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onClick={e => e.stopPropagation()}>
        <div className="modal-heading"><h2 id="project-dialog-title">{repair ? "确认重新关联" : ({ create: "新建项目", clone: "另存为新项目", rename: "重命名项目", open: "打开项目" })[mode]}</h2><button className="icon" disabled={pending && !canCancel} onClick={close} aria-label="关闭"><X size={18}/></button></div>
        {repair ? <>
          {repair.issue.horizon_id === null && <p>剖面范围和切片位置将重置。</p>}
          <dl className="project-detail"><dt>原文件</dt><dd>{repair.candidate.previous_path}</dd><dt>新文件</dt><dd>{repair.candidate.path}</dd><dt>数据概况</dt><dd>{repair.candidate.metadata.points ? `${repair.candidate.metadata.points} 个层位点` : `${repair.candidate.metadata.traces} 道 · ${repair.candidate.metadata.samples} 个采样点`}</dd></dl>
          {error && <p className="project-error" role="alert">{error}</p>}
          <div className="project-actions"><button className="secondary" disabled={pending} onClick={() => setRepair(null)}>返回</button><button className="primary" disabled={pending} onClick={() => {
            void execute({ type: "relink", id: repair.projectId, relink: { horizon_id: repair.issue.horizon_id, path: repair.candidate.path, confirm: true, revision: repair.candidate.revision, file_identity: repair.candidate.file_identity } }).then(result => {
              if (result) { setIssues(old => old.filter(i => i.horizon_id !== repair.issue.horizon_id)); setRepair(null); void refresh(); }
            }).catch(() => undefined);
          }}>{pending ? "正在关联…" : "确认关联"}</button></div>
        </> : mode === "open" ? <>
          <div className="project-browser-tools"><label className="project-search"><Search size={16}/><input aria-label="搜索项目" placeholder="搜索项目名称或数据文件…" value={query} onChange={e => setQuery(e.target.value)} disabled={pending}/></label><button className="secondary" disabled={pending} onClick={() => show("create")}><FilePlus2 size={15}/>新建项目</button></div>
          <div className="project-list" role="listbox" aria-label="项目列表" aria-busy={listing}>
            <div className="project-list-head" aria-hidden="true"><span>项目 / 数据文件</span><span>最近保存</span><span>文件状态</span></div>
            {filtered.map(p => <button role="option" aria-selected={selected === p.id} key={p.id} className={`project-row${selected === p.id ? " selected" : ""}`} disabled={pending} onClick={() => { setSelected(p.id); setIssues([]); setError(""); }} onDoubleClick={() => { if (p.status !== "damaged" && p.id !== project?.project_id) openProject(p.id); }}>
              <span className="project-row-title"><strong>{p.name}{p.id === project?.project_id && <small>当前</small>}</strong><span>{p.filename || "未导入数据"}</span></span><time>{timeLabel(p.updated_at)}</time><span className={`project-file-status ${p.status}`}>{({ missing: "文件缺失", unchecked: "待检查", empty: "空项目", damaged: "配置损坏" })[p.status]}</span>
            </button>)}
            {!filtered.length && <div className="project-list-empty">{listing ? "正在读取项目…" : query ? "没有匹配的项目" : "暂无项目"}</div>}
          </div>
          {chosen && <dl className="project-detail"><dt>项目</dt><dd>{chosen.name}</dd><dt>原始数据</dt><dd>{chosen.path || "未导入数据"}</dd><dt>层位</dt><dd>{chosen.horizon_count || 0} 个</dd></dl>}
          {error && <p className="project-error" role="alert">{error}</p>}
          {!!issues.length && <div className="project-issues">{issues.map(issue => <div key={issue.horizon_id || "survey"}><span>{issue.message}</span><button className="secondary" disabled={pending} onClick={() => void chooseRepair(issue)}><Link2 size={14}/>重新关联…</button></div>)}</div>}
          <div className="project-actions"><button className="secondary" disabled={pending && !canCancel} onClick={close}>取消</button><button className="primary" disabled={pending || !chosen || chosen.status === "damaged" || chosen.id === project?.project_id} onClick={() => openProject(selected)}>{pending ? <LoaderCircle size={15} className="spin"/> : <FolderOpen size={15}/>}打开项目</button></div>
        </> : <form onSubmit={e => { e.preventDefault(); void execute({ type: mode, name: name.trim(), requestId: requestId.current }).catch(() => undefined); }}>
          <label className="project-name-label">项目名称<input ref={nameInput} autoFocus required maxLength={80} value={name} onChange={e => setName(e.target.value)} disabled={pending}/></label>
          {mode === "clone" && <p className="project-note">新项目的导出队列为空。</p>}
          {error && <p className="project-error" role="alert">{error}</p>}
          <div className="project-actions"><button type="button" className="secondary" disabled={pending && !canCancel} onClick={close}>取消</button><button type="submit" className="primary" disabled={pending || !name.trim()}>{pending ? "正在处理…" : mode === "rename" ? "保存名称" : "创建并打开"}</button></div>
        </form>}
      </div>
    </div>}
  </>;
}
