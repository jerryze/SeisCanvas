import { LoaderCircle, Plus, X } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/useModalFocus";
import { Num, Toggle } from "./Controls";
import { ExportDialogSettings } from "../types";

type Props = {
  title: string;
  settings: ExportDialogSettings;
  onChange: (patch: Partial<ExportDialogSettings>) => void;
  onClose: () => void;
  onExport: () => void;
  busy: boolean;
  disabled?: boolean;
  error?: string;
  scene?: boolean;
  /** A–B profile dialog: exposes the removable figure furniture. */
  profile?: boolean;
  /** Present only for map exports; false until two valid endpoints exist. */
  mapProfileAvailable?: boolean;
  colorbar?: boolean;
  onColorbar?: (value: boolean) => void;
  rendering?: boolean;
  filename?: {
    value: string;
    extension: string;
    resolved: string;
    pending: boolean;
    error: string;
    onChange: (value: string) => void;
    onReset: () => void;
  };
};

export default function ExportDialog({
  title,
  settings: s,
  onChange: patch,
  onClose,
  onExport,
  busy,
  disabled,
  error,
  scene = false,
  profile = false,
  mapProfileAvailable,
  colorbar,
  onColorbar,
  filename,
}: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, true, onClose, !busy);
  const axes = s.show_axes !== false;
  return createPortal(
    <div className="modal-backdrop">
      <div
        className="modal export-dialog"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
          </div>
          <button
            className="icon"
            title="关闭保存图件"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="export-content">
          <fieldset className="export-settings" disabled={busy}>
            <section>
              <h3>文件格式</h3>
              <div
                className="format-options compact"
                role="group"
                aria-label="文件格式"
              >
                {(["png", "pdf", "svg"] as const).map((format) => (
                  <button
                    key={format}
                    aria-pressed={s.format === format}
                    title={
                      scene && format !== "png"
                        ? "场景位图 + 坐标矢量"
                        : undefined
                    }
                    className={s.format === format ? "active" : ""}
                    onClick={() => patch({ format })}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h3>输出</h3>
              <div className="field-row export-output-row">
                <label>
                  长边（像素）
                  <Num
                    value={s.long_edge ?? 3000}
                    min={600}
                    max={4000}
                    step={100}
                    onChange={(long_edge) =>
                      patch({ canvas: "fit", long_edge })
                    }
                  />
                </label>
                <label>
                  背景
                  <select
                    aria-label="导出背景"
                    value={
                      s.background === "transparent" ? "transparent" : "white"
                    }
                    onChange={(e) => patch({ background: e.target.value })}
                  >
                    <option value="white">白色</option>
                    <option value="transparent">透明</option>
                  </select>
                </label>
              </div>
              {filename && (
                <div className="export-filename">
                  <div className="export-filename-heading">
                    <label htmlFor="export-filename">文件名</label>
                    <button className="text-action" onClick={filename.onReset}>
                      自动命名
                    </button>
                  </div>
                  <div className="export-filename-input">
                    <input
                      id="export-filename"
                      type="text"
                      value={filename.value}
                      maxLength={200}
                      placeholder={
                        filename.pending ? "正在分配文件名…" : "输入文件名"
                      }
                      aria-describedby={filename.error ? "export-filename-error" : undefined}
                      aria-busy={filename.pending}
                      aria-invalid={!!filename.error}
                      onChange={(e) => filename.onChange(e.target.value)}
                    />
                    <span>.{filename.extension}</span>
                  </div>
                  {filename.error && <p id="export-filename-error" className="organization-help" role="alert">
                    {filename.error}
                  </p>}
                </div>
              )}
            </section>
            <section>
              <h3>图面设置</h3>
              <div className="field-row">
                <label>
                  字体
                  <select
                    value={s.font}
                    onChange={(e) => patch({ font: e.target.value })}
                  >
                    {[
                      "Times New Roman",
                      "Arial",
                      "DejaVu Sans",
                      "DejaVu Serif",
                    ].map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </label>
                <label>
                  字号（磅）
                  <Num
                    value={s.font_size}
                    min={5}
                    max={30}
                    onChange={(font_size) => patch({ font_size })}
                  />
                </label>
              </div>
              <div className="export-toggles">
                <Toggle
                  label="坐标轴"
                  checked={axes}
                  onChange={(show_axes) => patch({ show_axes })}
                />
                <fieldset disabled={!axes}>
                  <Toggle
                    label="轴标签"
                    checked={!!(scene ? s.show_axis_labels : s.show_labels)}
                    onChange={(value) =>
                      patch(
                        scene
                          ? { show_axis_labels: value }
                          : { show_labels: value },
                      )
                    }
                  />
                </fieldset>
                {scene ? (
                  <Toggle
                    label="包围盒"
                    checked={s.show_bounding_box !== false}
                    onChange={(show_bounding_box) =>
                      patch({ show_bounding_box })
                    }
                  />
                ) : (
                  <Toggle
                    label="标题"
                    checked={s.show_title !== false}
                    onChange={(show_title) => patch({ show_title })}
                  />
                )}
                {profile && (
                  <>
                    <Toggle
                      label="层位曲线"
                      checked={s.show_curves !== false}
                      onChange={(show_curves) => patch({ show_curves })}
                    />
                    <fieldset disabled={s.show_curves === false}>
                      <Toggle
                        label="图例"
                        checked={s.show_legend !== false}
                        onChange={(show_legend) => patch({ show_legend })}
                      />
                    </fieldset>
                    <Toggle
                      label="A/B 标注"
                      checked={s.show_ab !== false}
                      onChange={(show_ab) => patch({ show_ab })}
                    />
                  </>
                )}
                {onColorbar && (
                  <Toggle
                    label="色标尺"
                    checked={!!colorbar}
                    onChange={onColorbar}
                  />
                )}
                {mapProfileAvailable !== undefined && (
                  <fieldset disabled={!mapProfileAvailable}>
                    <Toggle
                      label="A–B 连线与标注"
                      title={
                        mapProfileAvailable
                          ? "保存地图上的连线、端点和 A/B 标注"
                          : "请先在地图上拾取两个不同的 A、B 端点"
                      }
                      checked={mapProfileAvailable && s.show_ab !== false}
                      onChange={(show_ab) => patch({ show_ab })}
                    />
                  </fieldset>
                )}
              </div>
            </section>
          </fieldset>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="export-actions">
          <button className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              disabled ||
              (!!filename &&
                (filename.pending || !!filename.error || !filename.resolved))
            }
            onClick={onExport}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}{" "}
            {busy ? "正在保存…" : "保存到队列"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
