import { LoaderCircle, Plus, X } from "lucide-react";
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
  colorbar?: boolean;
  onColorbar?: (value: boolean) => void;
  rendering?: boolean;
  dataset: string;
  onDataset: (value: string) => void;
  datasetPlaceholder?: string;
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
  colorbar,
  onColorbar,
  dataset,
  onDataset,
  datasetPlaceholder,
}: Props) {
  const axes = s.show_axes !== false;
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
          </div>
          <button
            className="icon"
            title="关闭导出"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
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
                  onChange={(long_edge) => patch({ canvas: "fit", long_edge })}
                />
              </label>
              {s.format === "png" && (
                <label>
                  背景
                  <select
                    value={
                      s.background === "transparent" ? "transparent" : "white"
                    }
                    onChange={(e) => patch({ background: e.target.value })}
                  >
                    <option value="white">白色</option>
                    <option value="transparent">透明</option>
                  </select>
                </label>
              )}
            </div>
            <p className="export-hint">画布自适应内容，保留标注与安全边距。</p>
            {scene && s.format !== "png" && (
              <p className="export-hint">三维场景以高清图片嵌入文件。</p>
            )}
            <label className="field export-dataset">
              项目 / 数据集名称
              <input
                aria-label="项目或数据集名称"
                type="text"
                value={dataset}
                placeholder={datasetPlaceholder}
                onChange={(e) => onDataset(e.target.value)}
              />
            </label>
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
                  onChange={(show_bounding_box) => patch({ show_bounding_box })}
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
            </div>
          </section>
        </fieldset>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="export-actions">
          <button className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || disabled}
            onClick={onExport}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}{" "}
            {busy ? "正在渲染…" : "加入导出"}
          </button>
        </div>
      </div>
    </div>
  );
}
