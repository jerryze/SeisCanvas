import { useEffect, useRef, useState } from "react";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { HS, Meta, VS } from "../../types";
import { Group, Num, Toggle, SubsectionSummary, Select } from "../Controls";
import SidebarObject from "../SidebarObject";
import { useSidebarValue } from "../SidebarState";
import { Horizon3DControls } from "../SeismicViewer3D/Controls3D";

type Props = {
  view: VS;
  selected: string;
  onSelect: (id: string) => void;
  busy: string;
  meta: Meta | null;
  onStyle: (patch: Partial<HS>, id: string) => void;
  /** Toggle one horizon's visibility in the app-level view state. */
  onPatch: (update: (v: VS) => VS) => void;
  /** Delete a horizon (backend + state); the app wraps it with busy handling. */
  onDelete: (h: HS) => void;
  onRename: (h: HS, name: string) => void;
  onAdd: () => void;
};

/** Sidebar "层位" group: horizon list, import entry and the style editor. */
export default function HorizonPanel({
  view,
  selected,
  onSelect,
  busy,
  meta,
  onStyle: onHorizonStyle,
  onPatch,
  onDelete,
  onAdd,
  onRename,
}: Props) {
  const [openId, setOpenId] = useSidebarValue<string>("horizon-open", "");
  const [selectedId, setSelectedId] = useSidebarValue(
    "horizon-selected",
    selected,
  );
  const mapMode = view.view_mode === "map";

  return (
    <Group
      icon={<Layers size={20} />}
      title={mapMode ? "层位管理" : "层位"}
      count={view.horizons.length}
      defaultOpen={!mapMode}
    >
      <div className="horizon-list">
        {view.horizons.map((h) => {
          const onStyle = (patch: Partial<HS>) => onHorizonStyle(patch, h.id);
          return (
            <SidebarObject
              key={h.id}
              open={openId === h.id}
              selected={selectedId === h.id}
              hidden={!h.visible}
              title={`${openId === h.id ? "收起" : "展开"} ${h.name} ${mapMode ? "的剖面层位样式" : "属性"}`}
              label={h.name}
              labelControls={
                <>
                  <input
                    className="horizon-color"
                    aria-label={`${h.name} 层位颜色`}
                    title="修改层位颜色：用于线条、图例和单色曲面"
                    type="color"
                    value={h.color}
                    onChange={(e) => onStyle({ color: e.target.value })}
                  />
                  <HorizonName
                    name={h.name}
                    disabled={!!busy}
                    onOpen={() => {
                      setOpenId(h.id);
                      setSelectedId(h.id);
                      onSelect(h.id);
                    }}
                    onRename={(name) => onRename(h, name)}
                  />
                </>
              }
              onToggle={() => {
                setOpenId(openId === h.id ? "" : h.id);
                setSelectedId(h.id);
                onSelect(h.id);
              }}
              visibility={
                <input
                  aria-label={
                    mapMode ? `在 A–B 剖面中显示 ${h.name}` : `显示 ${h.name}`
                  }
                  title={mapMode ? "与 2D/3D 视图共用层位显隐" : undefined}
                  type="checkbox"
                  checked={h.visible}
                  onChange={(event) =>
                    onPatch((v) => ({
                      ...v,
                      horizons: v.horizons.map((a) =>
                        a.id === h.id
                          ? { ...a, visible: event.target.checked }
                          : a,
                      ),
                    }))
                  }
                />
              }
              action={
                <button
                  className="icon delete"
                  title={`删除 ${h.name}`}
                  disabled={!!busy}
                  onClick={() => onDelete(h)}
                >
                  <Trash2 size={13} />
                </button>
              }
            >
              {view.view_mode === "3d" && (
                <Horizon3DControls
                  horizon={h}
                  seismic={view.seismic}
                  onChange={onStyle}
                />
              )}

              {(view.view_mode === "2d" ||
                view.view_mode === "map" ||
                h.display_mode === "slice_intersections") && (
                <>
                  <div
                    className="horizon-style-section"
                    role="group"
                    aria-label="基础线条样式"
                  >
                    <label className="check">
                      <input
                        type="checkbox"
                        aria-label={
                          view.view_mode === "3d" ? "显示交线" : "显示线条"
                        }
                        checked={h.line.visible && h.line.style !== "none"}
                        onChange={(e) =>
                          onStyle({
                            line: {
                              ...h.line,
                              visible: e.target.checked,
                              style:
                                h.line.style === "none"
                                  ? "solid"
                                  : h.line.style,
                            },
                          })
                        }
                      />
                      <span>
                        {view.view_mode === "3d" ? "显示交线" : "显示线条"}
                      </span>
                    </label>
                    <div className="field-row field-row--select-number">
                      <label>
                        线型
                        <Select
                          aria-label="线型"
                          disabled={!h.line.visible || h.line.style === "none"}
                          value={
                            h.line.style === "none" ? "solid" : h.line.style
                          }
                          onChange={(e) =>
                            onStyle({
                              line: { ...h.line, style: e.target.value },
                            })
                          }
                        >
                          {[
                            ["solid", "─ 实线"],
                            ["dashed", "┄ 虚线"],
                            ["dotted", "··· 点线"],
                            ["dashdot", "┄· 点划线"],
                          ].map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label>
                        线宽 · pt
                        <Num
                          label={
                            view.view_mode === "3d"
                              ? "交线宽度（pt）"
                              : "线条宽度（pt）"
                          }
                          title="线宽（pt）"
                          disabled={!h.line.visible || h.line.style === "none"}
                          value={h.line.width}
                          min={0.2}
                          max={6}
                          step={0.1}
                          onChange={(width) =>
                            onStyle({ line: { ...h.line, width } })
                          }
                        />
                      </label>
                    </div>
                  </div>

                  <div
                    className="horizon-style-section"
                    role="group"
                    aria-label="标记样式"
                  >
                    <Toggle
                      label="显示标记点"
                      checked={h.marker.visible}
                      onChange={(visible) =>
                        onStyle({ marker: { ...h.marker, visible } })
                      }
                    />

                    <div className="field-row field-row--select-number">
                      <label>
                        点形
                        <Select
                          aria-label="点形"
                          disabled={!h.marker.visible}
                          value={h.marker.shape}
                          onChange={(e) =>
                            onStyle({
                              marker: {
                                ...h.marker,
                                shape: e.target.value,
                              },
                            })
                          }
                        >
                          {[
                            ["circle", "圆形"],
                            ["circle-open", "空心圆"],
                            ["square", "方形"],
                            ["triangle", "三角形"],
                            ["diamond", "菱形"],
                            ["cross", "叉形"],
                            ["plus", "十字"],
                            ["none", "无"],
                          ].map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </Select>
                      </label>

                      <label>
                        大小 · pt
                        <Num
                          label="标记大小（pt）"
                          disabled={!h.marker.visible}
                          value={h.marker.size}
                          min={1}
                          max={15}
                          onChange={(size) =>
                            onStyle({ marker: { ...h.marker, size } })
                          }
                        />
                      </label>
                    </div>
                  </div>

                  <div className="section-number">
                    <Toggle
                      label="黑色描边"
                      checked={h.outline.enabled}
                      onChange={(enabled) =>
                        onStyle({ outline: { ...h.outline, enabled } })
                      }
                    />

                    <Num
                      label="描边宽度"
                      disabled={!h.outline.enabled}
                      value={h.outline.width}
                      min={0}
                      max={4}
                      step={0.1}
                      onChange={(width) =>
                        onStyle({ outline: { ...h.outline, width } })
                      }
                    />
                  </div>
                </>
              )}
            </SidebarObject>
          );
        })}
      </div>

      <button
        className="panel-action full"
        disabled={!meta || !!busy}
        onClick={onAdd}
      >
        <Plus size={14} />
        {mapMode ? "导入层位" : "添加层位"}
      </button>

      {view.view_mode === "2d" && (
        <details className="subsettings">
          <SubsectionSummary title="全部层位显示设置" />
          <div className="subsettings-body">
            <Toggle
              label="平滑曲线"
              checked={view.smooth_horizons ?? false}
              onChange={(smooth_horizons) =>
                onPatch((v) => ({ ...v, smooth_horizons }))
              }
            />
            <Toggle
              label="SG 平滑显示"
              checked={view.horizon_sg ?? false}
              onChange={(horizon_sg) => onPatch((v) => ({ ...v, horizon_sg }))}
            />
            {view.horizon_sg && (
              <label className="field">
                平滑窗口
                <Select
                  aria-label="平滑窗口"
                  value={view.horizon_sg_window ?? 7}
                  onChange={(e) =>
                    onPatch((v) => ({
                      ...v,
                      horizon_sg_window: Number(
                        e.target.value,
                      ) as VS["horizon_sg_window"],
                    }))
                  }
                >
                  {[5, 7, 11, 15].map((window) => (
                    <option key={window} value={window}>
                      {window} 道
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
        </details>
      )}
    </Group>
  );
}

function HorizonName({
  name,
  disabled,
  onOpen,
  onRename,
}: {
  name: string;
  disabled: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (!disabled && restoreFocus.current) {
      if (document.activeElement === document.body) button.current?.focus();
      restoreFocus.current = false;
    }
  }, [editing, disabled]);

  const beginEditing = () => {
    if (disabled) return;
    onOpen();
    cancelled.current = false;
    restoreFocus.current = false;
    setDraft(name);
    setEditing(true);
  };

  if (editing)
    return (
      <input
        ref={input}
        className="horizon-name-input"
        aria-label="层位名"
        title="Enter 保存，Esc 取消"
        type="text"
        value={draft}
        maxLength={200}
        onClick={onOpen}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const next = draft.trim();
          if (!cancelled.current && next && next !== name) onRename(next);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            cancelled.current = e.key === "Escape";
            restoreFocus.current = true;
            e.currentTarget.blur();
          }
        }}
      />
    );
  return (
    <button
      ref={button}
      type="button"
      className="horizon-name"
      aria-label={`重命名 ${name}`}
      title={`${name} · 单击展开，双击重命名（键盘 Enter / F2）`}
      disabled={disabled}
      onClick={onOpen}
      onDoubleClick={beginEditing}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          beginEditing();
        }
      }}
    >
      <span>{name}</span>
      <Pencil aria-hidden="true" size={12} />
    </button>
  );
}
