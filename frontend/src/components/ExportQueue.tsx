import { useEffect, useState } from "react";
import { Check, Download, Eye, LoaderCircle, Package, Pencil, Trash2, X } from "lucide-react";
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
  onExportAll: () => void;
};

/** Export Queue: manage the figures already rendered into the session. */
export default function ExportQueue({
  open,
  items,
  busy,
  onClose,
  onRename,
  onDelete,
  onClear,
  onExportAll,
}: Props) {
  const [preview, setPreview] = useState<ExportItem | null>(null);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    if (!items.some((item) => item.id === editing)) setEditing("");
  }, [items, editing]);
  useEffect(() => {
    if (!open) {
      setPreview(null);
      setEditing("");
      setConfirming(false);
    }
  }, [open]);

  if (!open) return null;

  const startRename = (item: ExportItem) => {
    setEditing(item.id);
    setDraft(item.filename);
    setConfirming(false);
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
  const previewUrl = (item: ExportItem) =>
    `/api/export/queue/${item.id}/file?v=${encodeURIComponent(item.filename)}`;

  return (
    <>
      <div className="queue-backdrop" onClick={onClose} />
      <aside className="queue-drawer" role="dialog" aria-modal="true" aria-label="导出队列">
        <header className="queue-head">
          <div>
            <h2>{items.length} 张图</h2>
          </div>
          <button className="icon" title="关闭导出队列" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="queue-list">
          {!items.length && (
            <div className="queue-empty">
              <Package size={26} strokeWidth={1.5} />
              <p>队列为空</p>
            </div>
          )}
          {items.map((item) => (
            <article className="queue-item" key={item.id}>
              <div className="queue-index">{String(item.index).padStart(2, "0")}</div>
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
                        if (e.key === "Escape") setEditing("");
                      }}
                    />
                    <button className="icon" title="保存文件名" disabled={renaming} onClick={() => submitRename(item)}>
                      <Check size={14} />
                    </button>
                    <button className="icon" title="取消重命名" onClick={() => setEditing("")}>
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <p className="queue-filename" title={item.filename}>
                    {item.filename}
                  </p>
                )}
                <span className="queue-detail">
                  {item.detail}
                  <em>{item.folder || "根目录"}</em>
                </span>
                <div className="queue-actions">
                  <button className="secondary" onClick={() => setPreview(item)}>
                    <Eye size={13} /> 预览
                  </button>
                  <button className="secondary" disabled={!!busy} onClick={() => startRename(item)}>
                    <Pencil size={13} /> 重命名
                  </button>
                  <button className="secondary danger" disabled={!!busy} onClick={() => onDelete(item)}>
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>

        <footer className="queue-foot">
          {confirming ? (
            <div className="queue-confirm">
              <span>清空 {items.length} 个暂存图片？</span>
              <button className="secondary" onClick={() => setConfirming(false)}>取消</button>
              <button
                className="primary"
                disabled={!!busy}
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
              <button
                className="secondary"
                disabled={!items.length || !!busy}
                onClick={() => setConfirming(true)}
              >
                清空队列
              </button>
              <button
                className="primary"
                disabled={!items.length || !!busy}
                onClick={onExportAll}
              >
                {busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />} 导出全部
              </button>
            </>
          )}
          <span className="queue-session">已自动保存，重启后可继续导出</span>
        </footer>
      </aside>

      {preview && (
        <div className="modal-backdrop queue-preview-backdrop" onClick={() => setPreview(null)}>
          <div
            className="modal queue-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`预览 ${preview.filename}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <h2>{preview.filename}</h2>
              </div>
              <button className="icon" title="关闭预览" onClick={() => setPreview(null)}>
                <X size={20} />
              </button>
            </div>
            <p className="export-note">{preview.detail}</p>
            {preview.format === "pdf" ? (
              <iframe className="queue-preview-frame" src={previewUrl(preview)} title={preview.filename} />
            ) : (
              <img className="queue-preview-image" src={previewUrl(preview)} alt={preview.filename} />
            )}
            <div className="export-actions">
              <a className="primary" href={previewUrl(preview)} download={preview.filename}>
                <Download size={15} /> 单独下载
              </a>
              <button className="secondary" onClick={() => setPreview(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
