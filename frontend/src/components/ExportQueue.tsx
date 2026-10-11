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
  Trash2,
  X,
} from "lucide-react";
import type { ExportItem } from "../types";

type Props = {
  open: boolean;
  items: ExportItem[];
  session: string;
  busy: boolean;
  onClose: () => void;
  onRename: (item: ExportItem, filename: string) => Promise<void>;
  onDelete: (item: ExportItem) => void;
  onClear: () => void;
  onExport: (itemIds?: string[]) => void;
};

const folderLabel = (folder: string) =>
  ({
    "2D/Inline": "2D · Inline",
    "2D/Crossline": "2D · Crossline",
    "3D": "3D 场景",
    HorizonMap: "层位地图 / A–B",
    HorizonProfile: "层位剖面",
  })[folder] ||
  folder ||
  "其他";
const fileUrl = (item: ExportItem) =>
  `/api/export/queue/${item.id}/file?v=${encodeURIComponent(item.filename)}`;

/** Browse and export the figures already rendered and saved in the session. */
export default function ExportQueue({
  open,
  items,
  session,
  busy,
  onClose,
  onRename,
  onDelete,
  onClear,
  onExport,
}: Props) {
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
          {!visible.length && (
            <div className="queue-empty">
              {items.length ? (
                <Search size={28} strokeWidth={1.5} />
              ) : (
                <Package size={28} strokeWidth={1.5} />
              )}
              <p>{items.length ? "没有匹配的图片" : "队列为空"}</p>
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
                  {String(item.index).padStart(2, "0")} ·{" "}
                  {item.format.toUpperCase()}
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
                <span className="queue-detail">{item.detail}</span>
                <span
                  className="queue-location"
                  title={`${item.dataset} · ${folderLabel(item.folder)}`}
                >
                  {item.dataset} · {folderLabel(item.folder)}
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
            <p className="export-note">
              {preview.detail} · {preview.dataset}
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
            <div className="export-actions">
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
