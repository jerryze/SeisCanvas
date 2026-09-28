import { LoaderCircle, Plus, X } from "lucide-react";
import { Num, Toggle } from "./Controls";
import { ExportDialogSettings, MAX_SCENE_PIXELS, exportPixels } from "../types";

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
  colorbar,
  onColorbar,
  rendering = true,
  dataset,
  onDataset,
  datasetPlaceholder,
}: Props) {
  const axes = s.show_axes !== false;
  const pixels = scene ? exportPixels(s) : null;
  const overBudget =
    !!pixels && pixels.pixels[0] * pixels.pixels[1] > MAX_SCENE_PIXELS;
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
            <span className="eyebrow">ADD TO EXPORT</span>
            <h2>{title}</h2>
          </div>
          <button className="icon" title="关闭导出" disabled={busy} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <fieldset className="export-settings" disabled={busy}>
          <section>
            <h3>文件格式</h3>
            <div className="format-options compact">
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
            <h3>尺寸与清晰度</h3>
            <div className="field-row">
              <label>
                宽度 · mm
                <Num value={s.width} min={scene ? 30 : 40} max={500} onChange={(width) => patch({ width })} />
              </label>
              <label>
                高度 · mm
                <Num value={s.height} min={scene ? 20 : 30} max={500} onChange={(height) => patch({ height })} />
              </label>
              <label>
                DPI
                <select value={s.dpi} onChange={(e) => patch({ dpi: +e.target.value })}>
                  {[300, 600].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {pixels && (
              <p className={`export-note${overBudget ? " over-budget" : ""}`}>
                {overBudget
                  ? `三维栅格渲染上限为 ${MAX_SCENE_PIXELS / 1_000_000} 百万像素（当前约 ${(
                      (pixels.pixels[0] * pixels.pixels[1]) /
                      1_000_000
                    ).toFixed(1)} 百万），请减小尺寸或降低 DPI。`
                  : `输出光栅 ${pixels.pixels[0]} × ${pixels.pixels[1]} px（${pixels.scale}× 采样）。`}
              </p>
            )}
          </section>
          {rendering && (
            <section>
              <h3>渲染质量 · Rendering Quality</h3>
              <label className="field">
                插值方式 · Interpolation
                <select
                  value={s.interpolation}
                  onChange={(e) => patch({ interpolation: e.target.value as ExportDialogSettings["interpolation"] })}
                >
                  {[
                    ["bilinear", "Bilinear"],
                    ["bicubic", "Bicubic"],
                    ["nearest", "Nearest"],
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              {!scene && (
                <label className="field">
                  分辨率 · Resolution
                  <select
                    value={s.resolution}
                    onChange={(e) => patch({ resolution: e.target.value as ExportDialogSettings["resolution"] })}
                  >
                    <option value="export">Match Export Resolution</option>
                    <option value="view">Use View Resolution</option>
                  </select>
                </label>
              )}
            </section>
          )}
          <section>
            <h3>数据集 · Dataset</h3>
            <label className="field">
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
            <h3>文字样式</h3>
            <div className="field-row">
              <label>
                字体
                <select value={s.font} onChange={(e) => patch({ font: e.target.value })}>
                  {["Times New Roman", "Arial", "DejaVu Sans", "DejaVu Serif"].map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label>
                字号 · pt
                <Num value={s.font_size} min={5} max={30} onChange={(font_size) => patch({ font_size })} />
              </label>
            </div>
          </section>
          <section>
            <h3>图面元素</h3>
            <div className="export-toggles">
              <Toggle label="显示坐标轴" checked={axes} onChange={(show_axes) => patch({ show_axes })} />
              <fieldset disabled={!axes}>
                <Toggle
                  label="显示轴标签"
                  checked={!!(scene ? s.show_axis_labels : s.show_labels)}
                  onChange={(value) => patch(scene ? { show_axis_labels: value } : { show_labels: value })}
                />
              </fieldset>
              {scene ? (
                <Toggle
                  label="显示包围盒"
                  checked={s.show_bounding_box !== false}
                  onChange={(show_bounding_box) => patch({ show_bounding_box })}
                />
              ) : (
                <Toggle
                  label="显示标题"
                  checked={s.show_title !== false}
                  onChange={(show_title) => patch({ show_title })}
                />
              )}
              {onColorbar && (
                <Toggle label="显示色标尺" checked={!!colorbar} onChange={onColorbar} />
              )}
            </div>
            {scene && (
              <label className="field">
                背景颜色
                <input
                  aria-label="导出背景颜色"
                  type="color"
                  value={s.background}
                  onChange={(e) => patch({ background: e.target.value })}
                />
              </label>
            )}
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
            disabled={busy || disabled || overBudget}
            onClick={onExport}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{" "}
            {busy ? "正在渲染…" : "Add to Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
