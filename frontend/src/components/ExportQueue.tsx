import { useEffect, useMemo, useRef, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import {
  Check,
  Download,
  Eye,
  FileText,
  LoaderCircle,
  Package,
  Pencil,
  Search,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import type { ExportItem, ExportJob } from "../types";
import { projectFileUrl } from "../api/client";

type Props = {
  open: boolean;
  items: ExportItem[];
  session: string;
  projectId?: string | null;
  busy: boolean;
  onClose: () => void;
  onRename: (item: ExportItem, filename: string) => Promise<void>;
  onDelete: (item: ExportItem) => void;
  onClear: () => void;
  onExport: (itemIds?: string[]) => void;
  onRestore: (item: ExportItem) => void;
  jobs?: ExportJob[];
  pendingJobIds?: Set<string>;
  onCancelJob?: (job: ExportJob) => Promise<void>;
  onRetryJob?: (job: ExportJob) => Promise<void>;
  error?: string;
};

const folderLabel = (folder: string) =>
  ({
    "2D/Inline": "2D Inline",
    "2D/Crossline": "2D Crossline",
    "3D": "3D 场景",
    HorizonMap: "层位地图 / A–B",
    HorizonProfile: "层位剖面",
  })[folder] ||
  folder ||
  "其他";

const jobKind = { "2d": "2D 剖面", "3d": "3D 场景", map: "层位地图", profile: "A–B 剖面" };
const jobStatus = { queued: "排队中", running: "生成中", completed: "已完成", failed: "生成失败", cancelled: "已取消" };
const jobStage: Record<string, string> = {
  queued: "排队中", reading: "读取数据", rendering: "生成图件", writing: "保存图件",
  completed: "已完成", failed: "生成失败", cancelled: "已取消",
};

/** Browse and export the figures already rendered and saved in the session. */
export default function ExportQueue({
  open,
  items,
  session,
  projectId = null,
  busy,
  onClose,
  onRename,
  onDelete,
  onClear,
  onExport,
  onRestore,
  jobs = [],
  pendingJobIds,
  onCancelJob,
  onRetryJob,
  error,
}: Props) {
  const fileUrl = (item: ExportItem) => projectFileUrl(item.id, item.filename, projectId);
  const [preview, setPreview] = useState<ExportItem | null>(null);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const drawer = useRef<HTMLElement>(null);
  const previewDialog = useRef<HTMLDivElement>(null);
  useModalFocus(
    drawer,
    open,
    () => {
      if (editing) setEditing("");
      else if (deleting) setDeleting("");
      else if (confirming) setConfirming(false);
      else onClose();
    },
    !busy && !renaming,
  );
  useModalFocus(previewDialog, open && !!preview, () => setPreview(null));

  useEffect(() => {
    if (!items.some((item) => item.id === editing)) setEditing("");
    if (!items.some((item) => item.id === deleting)) setDeleting("");
    setSelected(
      (current) =>
        new Set(
          [...current].filter((id) => items.some((item) => item.id === id)),
        ),
    );
    setFolder(current => current === "all" || items.some(item => item.folder === current) ? current : "all");
  }, [items]);
  useEffect(() => {
    setSelected(new Set());
    setQuery("");
    setFolder("all");
  }, [session]);
  useEffect(() => {
    if (!open) {
      setPreview(null);
      setEditing("");
      setConfirming(false);
      setDeleting("");
    }
  }, [open]);

  const folders = [...new Set(items.map((item) => item.folder))];
  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return items.filter(
      (item) =>
        (folder === "all" || item.folder === folder) &&
        [
          item.filename,
          item.dataset,
          item.folder,
          item.format,
          item.detail,
          folderLabel(item.folder),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(term),
    );
  }, [items, query, folder]);
  const allVisibleSelected =
    visible.length > 0 && visible.every((item) => selected.has(item.id));
  const selectedVisible = visible.filter((item) =>
    selected.has(item.id),
  ).length;
  const selectedIds = items
    .filter((item) => selected.has(item.id))
    .map((item) => item.id);
  const pendingJobs = jobs.filter(job => job.status !== "completed");
  const activeJobs = jobs.filter(job => job.status === "queued" || job.status === "running").length;
  const toggleItem = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleVisible = () =>
    setSelected((current) => {
      const next = new Set(current);
      visible.forEach((item) => {
        if (allVisibleSelected) next.delete(item.id);
        else next.add(item.id);
      });
      return next;
    });
  const resetFilter = () => {
    setQuery("");
    setFolder("all");
  };
  const startRename = (item: ExportItem) => {
    setEditing(item.id);
    setDraft(item.filename);
    setConfirming(false);
    setDeleting("");
  };
  const submitRename = async (item: ExportItem) => {
    const value = draft.trim();
    setEditing("");
    if (value && value !== item.filename) {
      setRenaming(true);
      try {
        await onRename(item, value);
      } finally {
        setRenaming(false);
      }
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        className="queue-backdrop"
        onClick={() => {
          if (!busy && !renaming) onClose();
        }}
      />
      <aside
        ref={drawer}
        tabIndex={-1}
        className="queue-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="导出队列"
      >
        <header className="queue-head">
          <div>
            <h2>
              导出队列 <span className="queue-count">{items.length}</span>
            </h2>
          </div>
          <button
            className="icon"
            title="关闭导出队列"
            disabled={busy || renaming}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        {error && <p className="error queue-restore-error" role="alert">{error}</p>}
        <div className="queue-filter">
          <div className="queue-search">
            <Search size={16} />
            <input
              type="search"
              aria-label="搜索导出图片"
              placeholder="搜索文件名、项目或格式"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="icon"
                title="清除搜索"
                onClick={() => setQuery("")}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <select
            aria-label="筛选图片类型"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          >
            <option value="all">全部类型</option>
            {folders.map((value) => (
              <option key={value} value={value}>
                {folderLabel(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="queue-selection">
          <label className="check">
            <input
              type="checkbox"
              aria-label="全选当前结果"
              disabled={!visible.length}
              checked={allVisibleSelected}
              ref={(node) => {
                if (node)
                  node.indeterminate =
                    selectedVisible > 0 && !allVisibleSelected;
              }}
              onChange={toggleVisible}
            />
            全选当前结果
          </label>
          <span role="status">
            {visible.length} / {items.length} 张
          </span>
          {!!selectedIds.length && (
            <button
              className="queue-text-button"
              onClick={() => setSelected(new Set())}
            >
              取消选择
            </button>
          )}
        </div>

        <div className="queue-list">
          {!!pendingJobs.length && (
            <section className="queue-jobs" aria-label="图件生成任务">
              <div className="queue-jobs-heading">
                <b className="meta-inline">生成任务{activeJobs > 0 && <span className="meta-count">{activeJobs} 项进行中</span>}</b>
                <span>可关闭队列继续浏览</span>
              </div>
              <div className="queue-jobs-list">
                {pendingJobs.map(job => (
                  <article className={`queue-job queue-job-${job.status}`} key={job.id}>
                    <div className="queue-job-body">
                      <p className="queue-job-title meta-inline" title={job.label?.replaceAll(" · ", "　")}>{(job.label || jobKind[job.kind]).split(" · ").map((part, index) => <span key={index}>{part}</span>)}</p>
                      <span className="queue-job-stage">
                        {job.status === "running" && <LoaderCircle size={12} className="spin" />}
                        <span>{jobKind[job.kind]}</span><span>{jobStage[job.stage] || jobStatus[job.status]}</span>
                        {(job.attempts || 1) > 1 && <span>第 {job.attempts} 次尝试</span>}
                      </span>
                      {job.status === "failed" && job.error && <p className="queue-job-error">{job.error}</p>}
                    </div>
                    {job.status === "queued" && onCancelJob && (
                      <button className="secondary" disabled={pendingJobIds?.has(job.id)}
                        aria-label={`取消排队 ${job.label}`} onClick={() => void onCancelJob(job)}>
                        <X size={13} /> 取消排队
                      </button>
                    )}
                    {job.status === "failed" && onRetryJob && (
                      <button className="secondary" disabled={pendingJobIds?.has(job.id)}
                        aria-label={`重试 ${job.label}`} onClick={() => void onRetryJob(job)}>
                        <RotateCcw size={13} /> 重试
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
          {!visible.length && (
            <div className="queue-empty">
              {items.length ? (
                <Search size={28} strokeWidth={1.5} />
              ) : (
                <Package size={28} strokeWidth={1.5} />
              )}
              <p>{items.length ? "没有匹配的图片" : activeJobs ? "图件完成后会显示在这里" : "队列为空"}</p>
              {!!items.length && (
                <button className="secondary" onClick={resetFilter}>
                  清除筛选
                </button>
              )}
            </div>
          )}
          {visible.map((item) => (
            <article
              className={`queue-item${selected.has(item.id) ? " selected" : ""}`}
              key={item.id}
            >
              <input
                className="queue-item-check"
                type="checkbox"
                aria-label={`选择 ${item.filename}`}
                checked={selected.has(item.id)}
                onChange={() => toggleItem(item.id)}
              />
              <button
              className="queue-thumbnail"
              aria-label={`预览 ${item.filename}`}
                title={`预览 ${item.filename}`}
                onClick={() => setPreview(item)}
              >
                {item.format === "pdf" ? (
                  <FileText size={28} strokeWidth={1.5} />
                ) : (
                  <img loading="lazy" src={fileUrl(item)} alt="" />
                )}
                <span>
                  <span>{String(item.index).padStart(2, "0")}</span>
                  <span>{item.format.toUpperCase()}</span>
                </span>
              </button>
              <div className="queue-body">
                {editing === item.id ? (
                  <div className="queue-rename">
                    <input
                      autoFocus
                      aria-label={`重命名 ${item.filename}`}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitRename(item);
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditing("");
                        }
                      }}
                    />
                    <button
                      className="icon"
                      title="保存文件名"
                      disabled={renaming || busy}
                      onClick={() => submitRename(item)}
                    >
                      <Check size={14} />
                    </button>
                    <button
                      className="icon"
                      title="取消重命名"
                      onClick={() => setEditing("")}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <p className="queue-filename" title={item.filename}>
                    {item.filename}
                  </p>
                )}
                <span className="queue-detail meta-inline">{item.detail.split(" · ").map((part, index) => <span key={index}>{part}</span>)}</span>
                <span
                  className="queue-location"
                  title={`${item.dataset}（${folderLabel(item.folder)}）`}
                >
                  {item.dataset}（{folderLabel(item.folder)}）
                </span>
                {deleting === item.id ? (
                  <div className="queue-delete-confirm" role="alert">
                    <span>删除这张图片？</span>
                    <button
                      className="secondary"
                      onClick={() => setDeleting("")}
                    >
                      取消
                    </button>
                    <button
                      className="secondary danger"
                      disabled={busy}
                      onClick={() => {
                        setDeleting("");
                        onDelete(item);
                      }}
                    >
                      确认删除
                    </button>
                  </div>
                ) : (
                  <div className="queue-actions">
                    <button
                      className="secondary"
                      onClick={() => setPreview(item)}
                    >
                      <Eye size={13} /> 预览
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || renaming}
                      onClick={() => startRename(item)}
                    >
                      <Pencil size={13} /> 重命名
                    </button>
                    <a
                      className="queue-action-icon"
                      title={`下载 ${item.filename}`}
                      aria-label={`下载 ${item.filename}`}
                      href={fileUrl(item)}
                      download={item.filename}
                    >
                      <Download size={15} />
                    </a>
                    <button
                      className="icon queue-action-icon danger"
                      title={`删除 ${item.filename}`}
                      disabled={busy}
                      onClick={() => {
                        setDeleting(item.id);
                        setConfirming(false);
                        setEditing("");
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>

        <footer className="queue-foot">
          {confirming ? (
            <div className="queue-confirm">
              <span>清空全部 {items.length} 张图片？</span>
              <button
                className="secondary"
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onClear();
                }}
              >
                确认清空
              </button>
            </div>
          ) : (
            <>
              <div className="queue-export-summary" role="status">
                <b>
                  {selectedIds.length
                    ? `已选 ${selectedIds.length} 张`
                    : `共 ${items.length} 张图片`}
                </b>
                {selectedIds.length > selectedVisible && (
                  <span>
                    其中 {selectedIds.length - selectedVisible} 张不在当前筛选中
                  </span>
                )}
              </div>
              <button
                className="secondary"
                disabled={!items.length || busy}
                onClick={() => {
                  setConfirming(true);
                  setDeleting("");
                }}
              >
                清空队列
              </button>
              <button
                className="primary"
                disabled={!items.length || busy}
                onClick={() =>
                  onExport(selectedIds.length ? selectedIds : undefined)
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Download size={15} />
                )}
                {selectedIds.length
                  ? `导出所选（${selectedIds.length}）`
                  : `导出全部（${items.length}）`}
              </button>
            </>
          )}
        </footer>
      </aside>

      {preview && (
        <div
          className="modal-backdrop queue-preview-backdrop"
          onClick={() => setPreview(null)}
        >
          <div
            className="modal queue-preview"
            ref={previewDialog}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={`预览 ${preview.filename}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2 title={preview.filename}>{preview.filename}</h2>
              <button
                className="icon"
                title="关闭预览"
                onClick={() => setPreview(null)}
              >
                <X size={20} />
              </button>
            </div>
            <p className="export-note meta-inline">
              {preview.detail.split(" · ").map((part, index) => <span key={index}>{part}</span>)}<span>{preview.dataset}</span>
            </p>
            {preview.format === "pdf" ? (
              <iframe
                className="queue-preview-frame"
                src={fileUrl(preview)}
                title={preview.filename}
              />
            ) : (
              <img
                className="queue-preview-image"
                src={fileUrl(preview)}
                alt={preview.filename}
              />
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <div className="export-actions">
              <button className="secondary" disabled={busy || !preview.restorable}
                title={preview.restorable ? "恢复这张图件的视图与导出设置" : "旧图件未保存恢复快照"}
                onClick={() => onRestore(preview)}>
                {busy ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />} 恢复设置
              </button>
              <a
                className="primary"
                href={fileUrl(preview)}
                download={preview.filename}
              >
                <Download size={15} /> 单独下载
              </a>
              <button className="secondary" onClick={() => setPreview(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
