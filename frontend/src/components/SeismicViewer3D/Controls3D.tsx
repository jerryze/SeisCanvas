import ExportDialog from "../ExportDialog";
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
  ExportDialogSettings,
  makeSlice,
} from "../../types";
const titles = {
  inline: "Inline 切片",
  crossline: "Crossline 切片",
  time: "时间切片",
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
    <Group icon={<Layers size={16} />} title="三维切片">
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
      title="场景设置"
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
      <div className="field-row">
        <label className="field">
          三维显示
          <select
            value={h.display_mode}
            onChange={(e) =>
              onChange({ display_mode: e.target.value as HS["display_mode"] })
            }
          >
            <option value="full_surface">完整曲面</option>
            <option value="slice_intersections">
              切片交线
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
      </div>
      {h.display_mode === "full_surface" ? (
        <>
          <div className="field-row">
            <label className="field">
              着色依据
              <select value={h.color_by || "twt"}
                onChange={(e) => onChange({ color_by: e.target.value as HS["color_by"] })}>
                <option value="twt">TWT · 层位时间</option>
                <option value="solid">单色</option>
              </select>
            </label>
            {h.color_by !== "solid" && (
              <label className="field">
                层位色标
                <select value={h.horizon_colormap || "petrel"}
                  onChange={() => onChange({ horizon_colormap: "petrel" })}>
                  <option value="petrel">Petrel</option>
                </select>
                <span style={{ display: "block", height: 8, background: "linear-gradient(to right, #ff0000, #ff8000, #ffff00, #00c040, #00ffff, #0000ff, #8000c0, #ff00ff)" }} />
              </label>
            )}
          </div>
          <div className="check-row">
            <Toggle label="平滑着色"
              checked={h.smooth_shading !== false}
              onChange={(smooth_shading) => onChange({ smooth_shading })} />
            <Toggle label="柔和光照"
              checked={h.lighting !== false}
              onChange={(lighting) => onChange({ lighting })} />
          </div>
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
    </div>
  );
}
export function Export3DDialog({
  scene,
  busy,
  error,
  dataset,
  datasetPlaceholder,
  onDataset,
  onClose,
  onExport,
}: {
  scene: SceneSettings;
  busy: string;
  error: string;
  dataset: string;
  datasetPlaceholder?: string;
  onDataset: (value: string) => void;
  onClose: () => void;
  onExport: (s: Export3D) => void;
}) {
  const [settings, setSettings] = useState<Export3D>({
    format: "png",
    font: "Times New Roman",
    font_size: 10,
    width: 180,
    height: 120,
    dpi: 300,
    background: "#ffffff",
    show_axes: scene.show_axes,
    show_axis_labels: scene.show_axis_labels,
    show_bounding_box: scene.show_bounding_box,
    interpolation: "bicubic",
  });
  const patch = (p: Partial<ExportDialogSettings>) =>
    setSettings((s) => ({ ...s, ...(p as Partial<Export3D>) }));
  return <ExportDialog title="三维场景 · Add to Export" scene settings={settings}
    onChange={patch} onClose={onClose} onExport={() => onExport(settings)}
    dataset={dataset} onDataset={onDataset} datasetPlaceholder={datasetPlaceholder}
    busy={!!busy} error={error} />;
}
