import { useState } from "react";
import {
  Plus,
  Trash2,
  Box,
  Layers,
  Download,
  X,
  LoaderCircle,
} from "lucide-react";
import { Num, Toggle, Group } from "../Controls";
import {
  VS,
  Meta,
  SliceKind,
  Slice,
  SliceCollection,
  SceneSettings,
  HS,
  Export3D,
  makeSlice,
} from "../../types";
const titles = {
  inline: "Inline slices",
  crossline: "Crossline slices",
  time: "Time slices",
};
const prefixes = { inline: "IL", crossline: "XL", time: "TWT" };
export function SliceManager({
  slices,
  meta,
  onChange,
  disabled,
}: {
  slices: SliceCollection;
  meta: Meta;
  onChange: (s: SliceCollection) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState({
    inline: meta.inlines[Math.floor(meta.inlines.length / 2)],
    crossline: meta.crosslines[Math.floor(meta.crosslines.length / 2)],
    time:
      meta.time_range[0] +
      Math.round((meta.samples - 1) / 2) * meta.sample_interval,
  });
  const [message, setMessage] = useState("");
  const positions = (kind: SliceKind) =>
    kind === "inline"
      ? meta.inlines
      : kind === "crossline"
        ? meta.crosslines
        : Array.from(
            { length: meta.samples },
            (_, i) => meta.time_range[0] + i * meta.sample_interval,
          );
  function snap(kind: SliceKind, value: number) {
    return positions(kind).reduce((a, b) =>
      Math.abs(b - value) < Math.abs(a - value) ? b : a,
    );
  }
  function update(kind: SliceKind, id: string, patch: Partial<Slice>) {
    onChange({
      ...slices,
      [kind]: slices[kind].map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }
  function add(kind: SliceKind) {
    const pos = snap(kind, draft[kind]);
    if (slices[kind].some((s) => s.position === pos)) {
      setMessage("该位置已经存在，可在下方调整或显示。");
      return;
    }
    setMessage("");
    onChange({ ...slices, [kind]: [...slices[kind], makeSlice(pos)] });
  }
  return (
    <Group icon={<Layers size={16} />} title="三维切片 / Slices">
      {(["inline", "crossline", "time"] as const).map((kind) => (
        <div className="slice-family" key={kind}>
          <div className="slice-family-heading">
            {titles[kind]}
            <span>{slices[kind].length}</span>
          </div>
          <div className="slice-add">
            <label>
              {kind === "time" ? "时间 · ms" : "位置"}
              <Num
                value={draft[kind]}
                min={positions(kind)[0]}
                max={positions(kind).at(-1)}
                step={kind === "time" ? meta.sample_interval : 1}
                onChange={(n) =>
                  setDraft((v) => ({ ...v, [kind]: snap(kind, n) }))
                }
              />
            </label>
            <button
              className="secondary"
              title={`添加 ${titles[kind]}`}
              disabled={
                disabled ||
                slices[kind].length >= 12 ||
                Object.values(slices).flat().length >= 18
              }
              onClick={() => add(kind)}
            >
              <Plus size={14} />
              添加
            </button>
          </div>
          {slices[kind].map((slice) => (
            <details className="slice-item" key={slice.id}>
              <summary>
                <input
                  aria-label={`显示 ${prefixes[kind]} ${slice.position}`}
                  type="checkbox"
                  checked={slice.visible}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    update(kind, slice.id, { visible: e.target.checked })
                  }
                />
                <span>
                  {prefixes[kind]} {slice.position}
                  {kind === "time" ? " ms" : ""}
                </span>
                <span className="slice-opacity">
                  {Math.round(slice.opacity * 100)}%
                </span>
              </summary>
              <div className="slice-body">
                <label className="field">
                  位置
                  <Num
                    value={slice.position}
                    min={positions(kind)[0]}
                    max={positions(kind).at(-1)}
                    step={kind === "time" ? meta.sample_interval : 1}
                    onChange={(position) =>
                      update(kind, slice.id, { position: snap(kind, position) })
                    }
                  />
                </label>
                <input
                  aria-label={`${prefixes[kind]} ${slice.position} 位置滑块`}
                  type="range"
                  min={0}
                  max={positions(kind).length - 1}
                  value={positions(kind).indexOf(slice.position)}
                  onChange={(e) =>
                    update(kind, slice.id, {
                      position: positions(kind)[+e.target.value],
                    })
                  }
                />
                <label className="field">
                  透明度
                  <Num
                    value={slice.opacity}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(opacity) => update(kind, slice.id, { opacity })}
                  />
                </label>
                <Toggle
                  label="切片边框"
                  checked={slice.border.visible}
                  onChange={(visible) =>
                    update(kind, slice.id, {
                      border: { ...slice.border, visible },
                    })
                  }
                />
                <div className="field-row">
                  <label>
                    边框颜色
                    <input
                      aria-label={`${prefixes[kind]} ${slice.position} 边框颜色`}
                      type="color"
                      value={slice.border.color}
                      onChange={(e) =>
                        update(kind, slice.id, {
                          border: { ...slice.border, color: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    边框宽度 · pt
                    <Num
                      value={slice.border.width}
                      min={0.2}
                      max={6}
                      step={0.1}
                      onChange={(width) =>
                        update(kind, slice.id, {
                          border: { ...slice.border, width },
                        })
                      }
                    />
                  </label>
                </div>
                <button
                  className="secondary full"
                  onClick={() =>
                    onChange({
                      ...slices,
                      [kind]: slices[kind].filter((s) => s.id !== slice.id),
                    })
                  }
                >
                  <Trash2 size={12} />
                  移除此切片
                </button>
              </div>
            </details>
          ))}
        </div>
      ))}
      {message && <div className="control-note">{message}</div>}
      <div className="control-note">
        时间位置对齐最近的 SEG-Y 采样点。最多组合 18 个切片。
      </div>
    </Group>
  );
}
export function SceneControls({
  scene,
  onChange,
}: {
  scene: SceneSettings;
  onChange: (s: SceneSettings) => void;
}) {
  const patch = (p: Partial<SceneSettings>) => onChange({ ...scene, ...p });
  return (
    <Group
      icon={<Box size={16} />}
      title="三维场景 / Scene"
      defaultOpen={false}
    >
      <Toggle
        label="显示坐标轴"
        checked={scene.show_axes}
        onChange={(show_axes) => patch({ show_axes })}
      />
      <Toggle
        label="显示坐标轴标签"
        checked={scene.show_axis_labels}
        onChange={(show_axis_labels) => patch({ show_axis_labels })}
      />
      <Toggle
        label="显示包围盒"
        checked={scene.show_bounding_box}
        onChange={(show_bounding_box) => patch({ show_bounding_box })}
      />
      <label className="field">
        背景颜色
        <input
          aria-label="三维背景颜色"
          type="color"
          value={scene.background}
          onChange={(e) => patch({ background: e.target.value })}
        />
      </label>
      <div className="field-row">
        {["X 比例", "Y 比例", "Z 比例"].map((name, index) => (
          <label key={name}>
            {name}
            <Num
              value={scene.aspect_ratio[index]}
              min={0.1}
              max={5}
              step={0.1}
              onChange={(n) => {
                const ratio = [...scene.aspect_ratio] as [
                  number,
                  number,
                  number,
                ];
                ratio[index] = n;
                patch({ aspect_ratio: ratio });
              }}
            />
          </label>
        ))}
      </div>
      <label className="field">
        场景精度
        <select
          value={scene.quality}
          onChange={(e) =>
            patch({ quality: Number(e.target.value) as 128 | 256 | 512 })
          }
        >
          <option value={128}>快速 · 128</option>
          <option value={256}>均衡 · 256</option>
          <option value={512}>精细 · 512</option>
        </select>
      </label>
      <div className="control-note">
        显示比例不改变真实坐标。精度控制每方向最大采样点数；提高精度后再导出可保留更多细节。
      </div>
    </Group>
  );
}
export function Horizon3DControls({
  horizon: h,
  onChange,
}: {
  horizon: HS;
  onChange: (p: Partial<HS>) => void;
}) {
  return (
    <div className="horizon-3d-controls">
      <label className="field">
        三维显示
        <select
          value={h.display_mode}
          onChange={(e) =>
            onChange({ display_mode: e.target.value as HS["display_mode"] })
          }
        >
          <option value="full_surface">Full Surface · 完整曲面</option>
          <option value="slice_intersections">
            Slice Intersections · 交线
          </option>
        </select>
      </label>
      <label className="field">
        透明度
        <Num
          value={h.opacity}
          min={0}
          max={1}
          step={0.05}
          onChange={(opacity) => onChange({ opacity })}
        />
      </label>
      {h.display_mode === "full_surface" ? (
        <>
          <label className="field">
            曲面样式
            <select
              value={h.surface_mode}
              onChange={(e) =>
                onChange({ surface_mode: e.target.value as HS["surface_mode"] })
              }
            >
              <option value="surface">Surface · 曲面</option>
              <option value="wireframe">Wireframe · 网格</option>
              <option value="surface_wireframe">Surface + Wireframe</option>
            </select>
          </label>
          {h.surface_mode !== "surface" && (
            <label className="field">
              网格线宽
              <Num
                value={h.wireframe_width}
                min={0.2}
                max={6}
                step={0.1}
                onChange={(wireframe_width) => onChange({ wireframe_width })}
              />
            </label>
          )}
        </>
      ) : (
        <label className="field">
          时间容差 · ms
          <Num
            value={h.time_slice_tolerance}
            min={0}
            max={1000}
            step={1}
            onChange={(time_slice_tolerance) =>
              onChange({ time_slice_tolerance })
            }
          />
        </label>
      )}
      <div className="control-note">
        {h.display_mode === "full_surface"
          ? "有效范围内显示曲面，缺失拾取保持为空。"
          : "交线仅对应可见切片。时间切片显示容差范围内的层位点。"}
      </div>
    </div>
  );
}
export function Export3DDialog({
  scene,
  busy,
  error,
  onClose,
  onExport,
}: {
  scene: SceneSettings;
  busy: string;
  error: string;
  onClose: () => void;
  onExport: (s: Export3D) => void;
}) {
  const [settings, setSettings] = useState<Export3D>({
    format: "png",
    font: "DejaVu Sans",
    font_size: 10,
    width: 1200,
    height: 900,
    scale: 2,
    background: "#ffffff",
    show_axes: scene.show_axes,
    show_axis_labels: scene.show_axis_labels,
    show_bounding_box: scene.show_bounding_box,
  });
  const patch = (p: Partial<Export3D>) => setSettings((s) => ({ ...s, ...p }));
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="导出三维图片"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">3D PUBLICATION EXPORT</span>
            <h2>导出当前三维场景</h2>
          </div>
          <button
            className="icon"
            disabled={!!busy}
            title="关闭导出"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p>保留当前相机、切片、层位样式和显示比例。</p>
        <div className="format-options">
          {(["png", "pdf", "svg"] as const).map((format) => (
            <button
              key={format}
              className={settings.format === format ? "active" : ""}
              onClick={() => patch({ format })}
            >
              {format.toUpperCase()}
              <small>
                {format === "png"
                  ? "高分辨率位图"
                  : format === "pdf"
                    ? "论文排版"
                    : "SVG 图像"}
              </small>
            </button>
          ))}
        </div>
        <div className="field-row">
          <label>
            字体
            <select
              value={settings.font}
              onChange={(e) => patch({ font: e.target.value })}
            >
              {["DejaVu Sans", "DejaVu Serif", "Arial", "Times New Roman"].map(
                (f) => (
                  <option key={f}>{f}</option>
                ),
              )}
            </select>
          </label>
          <label>
            字号 · pt
            <Num
              value={settings.font_size}
              min={5}
              max={30}
              onChange={(font_size) => patch({ font_size })}
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            宽度 · px
            <Num
              value={settings.width}
              min={400}
              max={4000}
              onChange={(width) => patch({ width })}
            />
          </label>
          <label>
            高度 · px
            <Num
              value={settings.height}
              min={300}
              max={4000}
              onChange={(height) => patch({ height })}
            />
          </label>
          <label>
            分辨率倍率
            <select
              value={settings.scale}
              onChange={(e) => patch({ scale: +e.target.value })}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}×
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          背景颜色
          <input
            aria-label="导出背景颜色"
            type="color"
            value={settings.background}
            onChange={(e) => patch({ background: e.target.value })}
          />
        </label>
        <div className="check-row">
          <Toggle
            label="导出坐标轴"
            checked={settings.show_axes}
            onChange={(show_axes) => patch({ show_axes })}
          />
          <Toggle
            label="导出轴标签"
            checked={settings.show_axis_labels}
            onChange={(show_axis_labels) => patch({ show_axis_labels })}
          />
          <Toggle
            label="导出包围盒"
            checked={settings.show_bounding_box}
            onChange={(show_bounding_box) => patch({ show_bounding_box })}
          />
        </div>
        <div className="export-note">
          输出 {settings.width * settings.scale} ×{" "}
          {settings.height * settings.scale} px ·{" "}
          {settings.format.toUpperCase()}
          <br />
          字体与字号应用于坐标轴标签和刻度。PDF / SVG
          内嵌高分辨率三维渲染图，场景与文字均为栅格内容。输出精度沿用当前场景采样。
        </div>
        {error && <div className="error">{error}</div>}
        <button
          className="primary full"
          disabled={!!busy}
          onClick={() => onExport(settings)}
        >
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Download size={16} />
          )}{" "}
          {busy || `导出三维 ${settings.format.toUpperCase()}`}
        </button>
      </div>
    </div>
  );
}
