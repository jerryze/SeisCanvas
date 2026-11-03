import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, FilePlus2, FolderOpen, Link2, LoaderCircle, LogOut, Pencil, RotateCcw, Search, Trash2, X } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useModalFocus } from "../hooks/useModalFocus";
import type { WorkspaceResponse } from "../workspace";
import "./projectMenu.css";

export type ProjectAction = {
  type: "create" | "clone" | "rename" | "open" | "close" | "relink" | "delete" | "restore" | "purge";
  id?: string; name?: string; requestId?: string;
  relink?: { horizon_id: string | null; path?: string; confirm?: boolean; revision?: number; file_identity?: Record<string, string> };
  signal?: AbortSignal;
  onCommit?: () => void;
};
type ProjectEntry = {
  id: string; name: string; filename?: string | null; path?: string | null;
  horizon_count?: number; updated_at: string; status: "missing" | "unchecked" | "empty" | "damaged" | "purging";
};
type Issue = { horizon_id: string | null; message: string };
type Screen =
  | { type: "list" }
  | { type: "create" | "clone" | "rename"; target?: ProjectEntry; requestId: string }
  | { type: "delete"; target: ProjectEntry }
  | { type: "purge"; target: ProjectEntry }
  | { type: "repair"; projectId: string; issue: Issue; candidate: any };
type Props = {
  project: WorkspaceResponse | null; disabled: boolean; open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: ProjectAction) => Promise<any>;
};
const timeLabel = (value: string) => value ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const dataLabel = (p: ProjectEntry) => [p.filename ? "SEG-Y" : "", p.horizon_count ? `${p.horizon_count} 个层位` : ""].filter(Boolean).join(" + ") || "空项目";

/** One library, one selection, one subview. Selecting never switches the workspace. */
export default function ProjectMenu({ project, disabled, open, onOpenChange, onAction }: Props) {
  const [screen, setScreen] = useState<Screen>({ type: "list" });
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [deletedProjects, setDeletedProjects] = useState<ProjectEntry[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [listing, setListing] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const controller = useRef<AbortController | null>(null);
  const listingRequest = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const close = () => {
    if (!pending || canCancel) { controller.current?.abort(); onOpenChange(false); }
  };
  const back = () => { setScreen({ type: "list" }); setError(""); };
  const dismiss = () => {
    if (pending) { if (canCancel) close(); }
    else if (screen.type === "list") close();
    else back();
  };
  useModalFocus(dialog, open, dismiss, !pending || canCancel);

  async function refresh() {
    const request = ++listingRequest.current;
    setListing(true);
    try {
      const [active, deleted] = await Promise.all([api("/projects").then(r => r.json()), api("/projects?deleted=true").then(r => r.json())]);
      if (request === listingRequest.current) { setProjects(active.projects); setDeletedProjects(deleted.projects); }
    } catch (e) {
      if (request === listingRequest.current) setError((e as Error).message);
    } finally { if (request === listingRequest.current) setListing(false); }
  }
  useEffect(() => {
    if (!open) return;
    setScreen({ type: "list" }); setShowDeleted(false); setQuery("");
    setSelected(project?.project_id || ""); setError(""); setMessage(""); setIssues([]);
    void refresh();
    return () => { listingRequest.current++; };
  }, [open, project?.project_id]);
  useEffect(() => {
    if (!open || pending) return;
    if (screen.type === "delete" || screen.type === "purge") cancelDelete.current?.focus();
    else if (["create", "clone", "rename"].includes(screen.type)) nameInput.current?.select();
    else if (screen.type === "list") (dialog.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') || dialog.current?.querySelector<HTMLInputElement>('input'))?.focus();
  }, [open, screen, pending]);

  const entries = showDeleted ? deletedProjects : projects;
  const filtered = entries.filter(p => `${p.name} ${p.filename || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const chosen = filtered.find(p => p.id === selected);
  const isCurrent = !!chosen && chosen.id === project?.project_id;
  function showForm(type: "create" | "clone" | "rename", target?: ProjectEntry) {
    setError(""); setMessage("");
    setName(type === "rename" ? target!.name : type === "clone" ? `${target!.name.slice(0, 77)} 副本` : "未命名项目");
    setScreen({ type, target, requestId: crypto.randomUUID().replaceAll("-", "") });
  }
  async function execute(action: ProjectAction) {
    if (pending) return;
    setPending(true); setError(""); setMessage("");
    setCanCancel(["create", "clone", "open"].includes(action.type));
    controller.current = new AbortController();
    try {
      const result = await onAction({ ...action, signal: controller.current.signal, onCommit: () => setCanCancel(false) });
      if (["open", "create", "clone", "close"].includes(action.type)) onOpenChange(false);
      else if (["delete", "restore", "rename", "purge"].includes(action.type)) {
        setScreen({ type: "list" }); setIssues([]);
        if (action.type === "restore") { setShowDeleted(false); setQuery(""); setSelected(action.id!); setMessage("项目已恢复，可选择打开。"); }
        else if (action.type === "purge") { setSelected(""); setMessage("项目已彻底删除。"); }
        else if (action.type === "delete") { setSelected(""); setMessage("项目已移至最近删除。"); }
        else {
          setMessage("项目名称已更新。");
          const renamed = `${action.name} ${projects.find(p => p.id === action.id)?.filename || ""}`;
          if (!renamed.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) setQuery("");
        }
        // Deleting the active project mounts a fresh workspace and library.
        if (!result?.workspace) await refresh();
      }
      return result;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
      if (action.type === "purge") await refresh();
      if (e instanceof ApiError && e.code === "SOURCE_ISSUES") {
        setIssues(e.detail.issues); setSelected(e.detail.project_id); setShowDeleted(false); setQuery("");
        setScreen({ type: "list" }); await refresh();
      }
      throw e;
    } finally { setPending(false); }
  }
  const run = (action: ProjectAction) => { void execute(action).catch(() => undefined); };
  async function chooseRepair(issue: Issue) {
    try {
      const candidate = await execute({ type: "relink", id: selected, relink: { horizon_id: issue.horizon_id } });
      if (candidate && !candidate.cancelled) setScreen({ type: "repair", projectId: selected, issue, candidate });
    } catch { /* The dialog retains the error and selected project. */ }
  }
  const title = { list: "项目管理", create: "新建项目", clone: "创建项目副本", rename: "重命名项目", delete: "删除项目", purge: "彻底删除项目", repair: "重新关联数据" }[screen.type];
  const errorBlock = error && <p className="project-error" role="alert">{error}</p>;

  return <>
    <button className="project-switcher secondary" disabled={disabled} onClick={() => onOpenChange(true)} aria-label="项目管理" title={project?.name || "项目管理"}>
      <FolderOpen size={16}/><span>{project?.name || "项目管理"}</span>
    </button>
    {open && <div className="modal-backdrop project-backdrop">
      <div className={`modal project-dialog${screen.type === "list" ? " project-manager" : ""}`} ref={dialog} tabIndex={-1} role={screen.type === "delete" || screen.type === "purge" ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby="project-dialog-title" aria-describedby={screen.type === "delete" || screen.type === "purge" ? "project-delete-description" : undefined}>
        <div className="modal-heading">
          <div className="project-heading-title">{screen.type !== "list" && <button className="icon" disabled={pending} onClick={back} aria-label="返回项目列表"><ArrowLeft size={18}/></button>}<h2 id="project-dialog-title">{title}</h2></div>
          <button className="icon" disabled={pending && !canCancel} onClick={close} aria-label="关闭项目管理"><X size={18}/></button>
        </div>
        {screen.type === "list" ? <>
          <div className="project-list-tabs" role="group" aria-label="项目范围">{[false, true].map(deleted => <button key={String(deleted)} aria-pressed={showDeleted === deleted} disabled={pending} onClick={() => { setShowDeleted(deleted); setSelected(deleted ? "" : project?.project_id || ""); setQuery(""); setIssues([]); setError(""); setMessage(""); }}>{deleted ? "最近删除" : "全部项目"}<span>{deleted ? deletedProjects.length : projects.length}</span></button>)}</div>
          <div className="project-manager-body">
            <div className="project-browser-tools"><label className="project-search"><Search size={16}/><input aria-label="搜索项目" placeholder="搜索项目或数据文件" value={query} onChange={e => { setQuery(e.target.value); setIssues([]); setError(""); }} disabled={pending}/></label>{!showDeleted && <button className="secondary" disabled={pending} onClick={() => showForm("create")}><FilePlus2 size={15}/>新建项目</button>}</div>
            <div className="project-list" role="listbox" aria-label="项目列表" aria-busy={listing}>
              <div className="project-list-head" aria-hidden="true"><span>项目名称</span><span>包含数据</span><span>最近保存</span></div>
              {filtered.map((p, index) => <button role="option" aria-selected={selected === p.id} key={p.id} className={`project-row${selected === p.id ? " selected" : ""}`} disabled={pending} onClick={() => { setSelected(p.id); setIssues([]); setError(""); setMessage(""); }} onDoubleClick={() => { if (!showDeleted && p.status !== "damaged") p.id === project?.project_id ? close() : run({ type: "open", id: p.id }); }} onKeyDown={e => {
                const next = e.key === "ArrowDown" ? Math.min(index + 1, filtered.length - 1) : e.key === "ArrowUp" ? Math.max(index - 1, 0) : e.key === "Home" ? 0 : e.key === "End" ? filtered.length - 1 : null;
                if (next === null) return;
                e.preventDefault(); setSelected(filtered[next].id); setIssues([]); setError("");
                e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
              }}>
                <span className="project-row-title"><strong><span>{p.name}</span>{p.id === project?.project_id && <small>已打开</small>}</strong>{(p.status === "missing" || p.status === "damaged" || p.status === "purging") && <span className="project-file-warning">{p.status === "missing" ? "数据文件缺失" : p.status === "purging" ? "清理未完成" : "项目配置损坏"}</span>}</span><span className="project-data-label">{p.status === "damaged" || p.status === "purging" ? "—" : dataLabel(p)}</span><time>{timeLabel(p.updated_at)}</time>
              </button>)}
              {!filtered.length && <div className="project-list-empty">{listing ? "正在读取项目…" : query ? "没有匹配的项目" : showDeleted ? "最近删除为空" : "暂无项目"}</div>}
            </div>
            {chosen && <section className="project-selection" aria-label={`所选项目：${chosen.name}`}>
              <div className="project-selection-heading"><h3>{chosen.name}</h3>{!showDeleted && <div className="project-selection-actions">
                <button className="secondary" disabled={pending || chosen.status === "damaged"} onClick={() => showForm("rename", chosen)}><Pencil size={14}/>重命名</button>
                <button className="secondary" disabled={pending || chosen.status === "damaged"} onClick={() => showForm("clone", chosen)}><Copy size={14}/>创建副本</button>
                {isCurrent && <button className="secondary" disabled={pending} onClick={() => run({ type: "close", id: chosen.id })}><LogOut size={14}/>关闭项目</button>}
                <button className="secondary project-delete-action" disabled={pending} onClick={() => { setScreen({ type: "delete", target: chosen }); setError(""); }}><Trash2 size={14}/>删除</button>
              </div>}</div>
              {chosen.path && <dl className="project-source"><dt>SEG-Y</dt><dd title={chosen.path}>{chosen.path}</dd></dl>}
              {showDeleted && <div className="project-selection-actions"><button className="secondary project-delete-action" disabled={pending} onClick={() => { setScreen({ type: "purge", target: chosen }); setError(""); }}><Trash2 size={14}/>{chosen.status === "purging" ? "重试彻底删除" : "彻底删除"}</button></div>}
            </section>}
            {errorBlock}
            {message && <p className="project-feedback" role="status">{message}</p>}
            {!!issues.length && <div className="project-issues">{issues.map(issue => <div key={issue.horizon_id || "survey"}><span>{issue.message}</span><button className="secondary" disabled={pending} onClick={() => void chooseRepair(issue)}><Link2 size={14}/>重新关联</button></div>)}</div>}
          </div>
          <div className="project-manager-footer">
            <span className="project-current" title={project?.name}>当前项目：{project?.name || "无"}</span>
            {(!isCurrent || showDeleted) && <button className="secondary" disabled={pending && !canCancel} onClick={close}>{pending && canCancel ? "取消打开" : "完成"}</button>}
            {showDeleted ? <button className="primary" disabled={pending || !chosen || chosen.status === "purging"} onClick={() => run({ type: "restore", id: selected })}><RotateCcw size={15}/>恢复项目</button> : <button className="primary" disabled={pending || !chosen || chosen.status === "damaged"} onClick={() => isCurrent ? close() : run({ type: "open", id: selected })}>{pending ? <LoaderCircle size={15} className="spin"/> : <FolderOpen size={15}/>} {isCurrent ? "返回工作区" : "打开项目"}</button>}
          </div>
        </> : (screen.type === "delete" || screen.type === "purge") ? <>
          <p className="project-delete-name">{screen.target.name}</p>
          <p id="project-delete-description">{screen.type === "purge" ? "永久删除项目配置及图件，无法恢复。原始 SEG-Y 和层位文件保留。" : "移至“最近删除”，可恢复项目和图件。原始数据文件保留。"}</p>
          {screen.target.id === project?.project_id && <p>当前工作区将关闭。</p>}
          {errorBlock}
          <div className="project-actions"><button ref={cancelDelete} className="secondary" disabled={pending} onClick={back}>取消</button><button className="danger-button" disabled={pending} onClick={() => run({ type: screen.type, id: screen.target.id })}>{pending ? "正在删除…" : screen.type === "purge" ? "彻底删除" : "删除项目"}</button></div>
        </> : screen.type === "repair" ? <>
          {screen.issue.horizon_id === null && <p>剖面范围和切片位置将重置。</p>}
          <dl className="project-detail"><dt>原文件</dt><dd>{screen.candidate.previous_path}</dd><dt>新文件</dt><dd>{screen.candidate.path}</dd><dt>数据概况</dt><dd>{screen.candidate.metadata.points ? `${screen.candidate.metadata.points} 个层位点` : `${screen.candidate.metadata.traces} 道，${screen.candidate.metadata.samples} 个采样点`}</dd></dl>
          {errorBlock}
          <div className="project-actions"><button className="secondary" disabled={pending} onClick={back}>返回</button><button className="primary" disabled={pending} onClick={() => {
            void execute({ type: "relink", id: screen.projectId, relink: { horizon_id: screen.issue.horizon_id, path: screen.candidate.path, confirm: true, revision: screen.candidate.revision, file_identity: screen.candidate.file_identity } }).then(result => {
              if (result) { setIssues(old => old.filter(i => i.horizon_id !== screen.issue.horizon_id)); setScreen({ type: "list" }); void refresh(); }
            }).catch(() => undefined);
          }}>{pending ? "正在关联…" : "确认关联"}</button></div>
        </> : <form onSubmit={e => { e.preventDefault(); run({ type: screen.type, id: screen.target?.id, name: name.trim(), requestId: screen.requestId }); }}>
          {screen.type === "clone" && <p className="project-form-source">源项目：{screen.target?.name}</p>}
          <label className="project-name-label">{screen.type === "clone" ? "副本名称" : "项目名称"}<input ref={nameInput} required maxLength={80} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault(); }} disabled={pending}/></label>
          {screen.type === "clone" && <p className="project-note">保留数据引用与显示设置，图件和导出队列为空。</p>}
          {errorBlock}
          <div className="project-actions"><button type="button" className="secondary" disabled={pending && !canCancel} onClick={dismiss}>{pending ? "取消创建" : "取消"}</button><button type="submit" className="primary" disabled={pending || !name.trim()}>{pending ? "正在处理…" : screen.type === "rename" ? "保存名称" : "创建并打开"}</button></div>
        </form>}
      </div>
    </div>}
  </>;
}
