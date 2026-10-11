import ExportDialog from "../ExportDialog";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../../hooks/useModalFocus";
import {
  Plus,
  Trash2,
  Box,
  Layers,
  Download,
  X,
  LoaderCircle,
  ChevronDown,
} from "lucide-react";
import { Num, Toggle, Group, OpacityControl, StrokeControl, Select } from "../Controls";
import { PETREL_COLORMAP } from "./sceneGeometry";
import ColormapSelect from "../ColormapSelect";
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
  const [pendingDelete, setPendingDelete] = useState<{ kind: SliceKind; slice: Slice } | null>(null);
  const deleteDialog = useRef<HTMLDivElement>(null);
  useModalFocus(deleteDialog, !!pendingDelete, () => setPendingDelete(null), !disabled);
  const [message, setMessage] = useState("");
  const [addKind, setAddKind] = useState<SliceKind>("inline");
  const allSlices = Object.values(slices).flat();
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
      setMessage("该位置已经存在，可在列表中调整或显示。");
      return;
    }
    setMessage("");
    onChange({ ...slices, [kind]: [...slices[kind], makeSlice(pos)] });
  }
  return (
    <Group
      icon={<Layers size={16} />}
      title="三维切片"
      hint={`${allSlices.filter((slice) => slice.visible).length} / ${allSlices.length} 显示`}
    >
      {pendingDelete && createPortal(
        <div className="modal-backdrop" onClick={() => !disabled && setPendingDelete(null)}>
          <div ref={deleteDialog} tabIndex={-1} className="modal delete-horizon-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-slice-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="delete-slice-title">移除切片 {prefixes[pendingDelete.kind]} {pendingDelete.slice.position}{pendingDelete.kind === "time" ? " ms" : ""}？</h2>
            <p>将从当前场景移除此切片及其样式，地震数据会保留，可通过“添加切片”重新添加。</p>
            <div className="import-actions">
              <button className="secondary" disabled={disabled} onClick={() => setPendingDelete(null)}>取消</button>
              <button className="danger-button" disabled={disabled} onClick={() => {
                onChange({ ...slices, [pendingDelete.kind]: slices[pendingDelete.kind].filter((slice) => slice.id !== pendingDelete.slice.id) });
                setPendingDelete(null);
              }}>确认移除</button>
            </div>
          </div>
        </div>, document.body,
      )}
      <div className="slice-list">
        {(["inline", "crossline", "time"] as const).flatMap((kind) =>
          slices[kind].map((slice) => (
            <details
              className={`slice-item ${slice.visible ? "" : "slice-hidden"}`}
              key={slice.id}
            >
              <summary>
                <input
                  aria-label={`显示 ${prefixes[kind]} ${slice.position}`}
                  type="checkbox"
                  disabled={disabled}
                  checked={slice.visible}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    update(kind, slice.id, { visible: e.target.checked })
                  }
                />
                <span className="slice-kind" title={titles[kind]}>
                  {prefixes[kind]}
                </span>
                <span className="slice-position">
                  {slice.position}
                  {kind === "time" ? " ms" : ""}
                </span>
                <span className="slice-opacity">
                  {Math.round(slice.opacity * 100)}%
                </span>
                <ChevronDown
                  className="slice-chevron"
                  size={16}
                  strokeWidth={1.75}
                />
                <button
                  type="button"
                  className="icon delete"
                  title={`删除 ${prefixes[kind]} ${slice.position} 切片`}
                  aria-label={`删除 ${prefixes[kind]} ${slice.position} 切片`}
                  disabled={disabled}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setPendingDelete({ kind, slice });
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </summary>
              <div className="slice-body">
                <div
                  className="range-number"
                  role="group"
                  aria-label={`${prefixes[kind]} 切片位置`}
                >
                  <span>位置</span>
                  <input
                    aria-label={`${prefixes[kind]} ${slice.position} 位置滑块`}
                    type="range"
                    disabled={disabled}
                    min={0}
                    max={positions(kind).length - 1}
                    value={positions(kind).indexOf(slice.position)}
                    onChange={(e) =>
                      update(kind, slice.id, {
                        position: positions(kind)[+e.target.value],
                      })
                    }
                  />
                  <Num
                    label={`${prefixes[kind]} 切片位置${kind === "time" ? "（ms）" : ""}`}
                    disabled={disabled}
                    value={slice.position}
                    min={positions(kind)[0]}
                    max={positions(kind).at(-1)}
                    step={kind === "time" ? meta.sample_interval : 1}
                    onChange={(position) => {
                      const snapped = snap(kind, position);
                      update(kind, slice.id, { position: snapped });
                      return snapped;
                    }}
                  />
                </div>
                <StrokeControl
                  label="边框"
                  disabled={disabled}
                  visible={slice.border.visible}
                  color={slice.border.color}
                  width={slice.border.width}
                  onVisible={(visible) =>
                    update(kind, slice.id, {
                      border: { ...slice.border, visible },
                    })
                  }
                  onColor={(color) =>
                    update(kind, slice.id, {
                      border: { ...slice.border, color },
                    })
                  }
                  onWidth={(width) =>
                    update(kind, slice.id, {
                      border: { ...slice.border, width },
                    })
                  }
                />
                <OpacityControl
                  label={`${prefixes[kind]} 切片透明度`}
                  disabled={disabled}
                  value={slice.opacity}
                  onChange={(opacity) => update(kind, slice.id, { opacity })}
                />
              </div>
            </details>
          )),
        )}
      </div>
      <details
        className="subsettings slice-create"
        open={allSlices.length === 0 ? true : undefined}
      >
        <summary className="panel-action">
          <Plus size={14} />
          <span>添加切片</span>
        </summary>
        <div className="subsettings-body">
          <label className="field">
            <span>方向</span>
            <Select aria-label="新切片方向" value={addKind} disabled={disabled} onChange={(event) => {
              setAddKind(event.target.value as SliceKind);
              setMessage("");
            }}>
              <option value="inline">Inline</option>
              <option value="crossline">Crossline</option>
              <option value="time">时间</option>
            </Select>
          </label>
            <label className="section-number">
              <span title={addKind === "time" ? "时间（ms）" : "剖面编号"}>
                {addKind === "time" ? "时间（ms）" : "编号"}
              </span>
              <Num
                label={`新 ${titles[addKind]} 位置`}
                value={draft[addKind]}
                disabled={disabled}
                min={positions(addKind)[0]}
                max={positions(addKind).at(-1)}
                step={addKind === "time" ? meta.sample_interval : 1}
                onChange={(n) => {
                  const snapped = snap(addKind, n);
                  setDraft((v) => ({ ...v, [addKind]: snapped }));
                  setMessage("");
                  return snapped;
                }}
              />
            </label>
          <div className="slice-create-footer">
            <span className="control-note">
              范围 {positions(addKind)[0]}–{positions(addKind).at(-1)}
              {addKind === "time" ? " ms" : ""}
            </span>
            <button
              className="secondary"
              title={`添加 ${titles[addKind]}`}
              disabled={
                disabled ||
                slices[addKind].length >= 12 ||
                allSlices.length >= 18
              }
              onClick={() => add(addKind)}
            >
              <Plus size={14} />
              添加
            </button>
          </div>

          {message && (
            <div className="control-note" role="status">
              {message}
            </div>
          )}
          {(slices[addKind].length >= 12 || allSlices.length >= 18) && (
            <div className="control-note">已达到切片数量上限。</div>
          )}
        </div>
      </details>
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
    <Group icon={<Box size={16} />} title="场景设置" defaultOpen={false}>
      <div className="check-row">
        <Toggle
          label="坐标轴"
          title="显示坐标轴"
          checked={scene.show_axes}
          onChange={(show_axes) => patch({ show_axes })}
        />
        <Toggle
          label="轴标签"
          title="显示坐标轴标签"
          checked={scene.show_axis_labels}
          onChange={(show_axis_labels) => patch({ show_axis_labels })}
        />
      </div>
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
      <div
        className="field-row field-row--inline"
        role="group"
        aria-label="场景显示比例"
      >
        {["X", "Y", "Z"].map((name, index) => (
          <label key={name}>
            {name}
            <Num
              label={`${name} 比例`}
              title={`${name} 显示比例`}
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
        <Select
          value={scene.quality}
          onChange={(e) =>
            patch({ quality: Number(e.target.value) as 128 | 256 | 512 })
          }
        >
          <option value={128}>快速 · 128</option>
          <option value={256}>均衡 · 256</option>
          <option value={512}>精细 · 512</option>
        </Select>
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
      <label className="field">
        三维显示
        <Select
          aria-label="三维显示"
          value={h.display_mode}
          onChange={(e) =>
            onChange({ display_mode: e.target.value as HS["display_mode"] })
          }
        >
          <option value="full_surface">完整曲面</option>
          <option value="slice_intersections">切片交线</option>
        </Select>
      </label>
      <OpacityControl
        label="层位透明度"
        value={h.opacity}
        onChange={(opacity) => onChange({ opacity })}
      />
      {h.display_mode === "full_surface" ? (
        <>
          <label className="field">
            着色依据
            <Select
              aria-label="着色依据"
              value={h.color_by || "twt"}
              onChange={(e) =>
                onChange({ color_by: e.target.value as HS["color_by"] })
              }
            >
              <option value="twt">TWT 时间</option>
              <option value="solid">单色</option>
            </Select>
          </label>
          {h.color_by === "solid" ? (
            <label className="field">
              曲面颜色
              <input
                type="color"
                aria-label="曲面颜色"
                value={h.color}
                onChange={(e) => onChange({ color: e.target.value })}
              />
            </label>
          ) : (
            <ColormapSelect
              label="层位色标"
              value="petrel"
              options={[
                { value: "petrel", label: "Petrel", colors: PETREL_COLORMAP },
              ]}
              range={
                h.twt_range
                  ? `${Number(h.twt_range[0].toFixed(1))}–${Number(h.twt_range[1].toFixed(1))} ms`
                  : undefined
              }
            />
          )}
          <div className="check-row">
            <Toggle
              label="平滑着色"
              checked={h.smooth_shading !== false}
              onChange={(smooth_shading) => onChange({ smooth_shading })}
            />
            <Toggle
              label="柔和光照"
              checked={h.lighting !== false}
              onChange={(lighting) => onChange({ lighting })}
            />
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
  settings,
  onSettings,
  busy,
  error,
  dataset,
  datasetPlaceholder,
  onDataset,
  onClose,
  onExport,
}: {
  settings: Export3D;
  onSettings: (s: Export3D) => void;
  busy: string;
  error: string;
  dataset: string;
  datasetPlaceholder?: string;
  onDataset: (value: string) => void;
  onClose: () => void;
  onExport: (s: Export3D) => void;
}) {
  const patch = (p: Partial<ExportDialogSettings>) =>
    onSettings({ ...settings, ...(p as Partial<Export3D>) });
  return (
    <ExportDialog
      title="三维场景 · 保存图件"
      scene
      settings={settings}
      onChange={patch}
      onClose={onClose}
      onExport={() => onExport(settings)}
      dataset={dataset}
      onDataset={onDataset}
      datasetPlaceholder={datasetPlaceholder}
      busy={!!busy}
      error={error}
    />
  );
}
