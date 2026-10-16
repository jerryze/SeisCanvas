import { Layers, Plus, Trash2 } from "lucide-react";
import { HS, Meta, VS } from "../../types";
import {
  Group,
  Num,
  Toggle,
  SubsectionSummary,
  StrokeControl,
  Select,
  TextInput,
} from "../Controls";
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
      {mapMode && (
        <p className="control-note">
          地图内容由“地图层位”选择。下方勾选与线条样式用于 A–B
          剖面，并与其他视图共用。
        </p>
      )}
      <div className="horizon-list">
        {view.horizons.map((h) => {
          const onStyle = (patch: Partial<HS>) => onHorizonStyle(patch, h.id);
          return (
            <SidebarObject
              key={h.id}
              open={openId === h.id}
              selected={selectedId === h.id}
              hidden={!h.visible}
              title={
                mapMode ? `设置 ${h.name} 的剖面层位样式` : `设置 ${h.name}`
              }
              label={
                <>
                  <i style={{ background: h.color }} />
                  <span>{h.name}</span>
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
                  <StrokeControl
                    label={view.view_mode === "3d" ? "交线" : "线条"}
                    visible={h.line.visible}
                    color={h.color}
                    width={h.line.width}
                    disableColorWhenHidden={false}
                    onVisible={(visible) =>
                      onStyle({ line: { ...h.line, visible } })
                    }
                    onColor={(color) => onStyle({ color })}
                    onWidth={(width) => onStyle({ line: { ...h.line, width } })}
                  />

                  <label className="field">
                    线型
                    <Select
                      aria-label="线型"
                      disabled={!h.line.visible}
                      value={h.line.style}
                      onChange={(e) =>
                        onStyle({
                          line: { ...h.line, style: e.target.value },
                        })
                      }
                    >
                      {[
                        ["solid", "实线"],
                        ["dashed", "虚线"],
                        ["dotted", "点线"],
                        ["dashdot", "点划线"],
                        ["none", "无"],
                      ].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </label>

                  <details className="subsettings">
                    <SubsectionSummary title="标记与描边" />
                    <div className="subsettings-body">
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
                    </div>
                  </details>
                </>
              )}
              <details className="subsettings">
                <SubsectionSummary title="名称与图例颜色" />
                <div className="subsettings-body">
                  <label className="field">
                    层位名
                    <TextInput
                      key={`${h.id}:${h.name}`}
                      aria-label="层位名"
                      defaultValue={h.name}
                      maxLength={200}
                      disabled={!!busy}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        e.target.value = h.name;
                        if (name && name !== h.name) onRename(h, name);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          e.currentTarget.value = h.name;
                          e.currentTarget.blur();
                        }
                      }}
                    />
                  </label>
                  <label className="field">
                    图例颜色
                    <input
                      aria-label="图例颜色"
                      type="color"
                      value={h.color}
                      onChange={(e) => onStyle({ color: e.target.value })}
                    />
                  </label>
                </div>
              </details>
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
      {mapMode && (
        <p className="control-note">导入、移除和重命名会同步所有视图。</p>
      )}
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
