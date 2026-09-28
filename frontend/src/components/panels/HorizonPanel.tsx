import { ChevronRight, Layers, Plus, Trash2 } from "lucide-react";
import { HS, Meta, VS } from "../../types";
import { Group, Num, Toggle } from "../Controls";
import { Horizon3DControls } from "../SeismicViewer3D/Controls3D";

type Props = {
  view: VS;
  selected: string;
  onSelect: (id: string) => void;
  busy: string;
  meta: Meta | null;
  onStyle: (patch: Partial<HS>) => void;
  /** Toggle one horizon's visibility in the app-level view state. */
  onPatch: (update: (v: VS) => VS) => void;
  /** Delete a horizon (backend + state); the app wraps it with busy handling. */
  onDelete: (h: HS) => void;
  onAdd: () => void;
};

/** Sidebar "层位" group: horizon list, import entry and the style editor. */
export default function HorizonPanel({
  view,
  selected,
  onSelect,
  busy,
  meta,
  onStyle,
  onPatch,
  onDelete,
  onAdd,
}: Props) {
  const active = view.horizons.find((h) => h.id === selected);

  return (
    <Group icon={<Layers size={16} />} title={`层位 · ${view.horizons.length}`}>
      <div className="horizon-list">
        {view.horizons.map((h) => (
          <div
            key={h.id}
            className={`horizon-row ` + `${selected === h.id ? "selected" : ""}`}
          >
            <input
              aria-label={`显示 ${h.name}`}
              type="checkbox"
              checked={h.visible}
              onChange={(e) =>
                onPatch((v) => ({
                  ...v,
                  horizons: v.horizons.map((a) =>
                    a.id === h.id ? { ...a, visible: e.target.checked } : a,
                  ),
                }))
              }
            />

            <button className="horizon-select" onClick={() => onSelect(h.id)}>
              <i style={{ background: h.color }} />
              <span>{h.name}</span>
              <ChevronRight size={13} />
            </button>

            <button
              className="icon delete"
              title={`删除 ${h.name}`}
              onClick={() => onDelete(h)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      <button className="secondary full" disabled={!meta || !!busy} onClick={onAdd}>
        <Plus size={14} />
        添加层位
      </button>

      {active && (
        <div className="style-editor">
          <div className="style-title">
            <span>{active.name}</span>

            <input
              aria-label="层位颜色"
              type="color"
              value={active.color}
              onChange={(e) => onStyle({ color: e.target.value })}
            />
          </div>

          {view.view_mode === "3d" && (
            <Horizon3DControls horizon={active} onChange={onStyle} />
          )}

          {(view.view_mode === "2d" ||
            active.display_mode === "slice_intersections") && (
            <>
              <Toggle
                label="显示线条"
                checked={active.line.visible}
                onChange={(visible) =>
                  onStyle({ line: { ...active.line, visible } })
                }
              />

              <div className="field-row">
                <label>
                  线型
                  <select
                    value={active.line.style}
                    onChange={(e) =>
                      onStyle({
                        line: { ...active.line, style: e.target.value },
                      })
                    }
                  >
                    {["solid", "dashed", "dotted", "dashdot", "none"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>

                <label>
                  线宽 · pt
                  <Num
                    value={active.line.width}
                    min={0.2}
                    max={6}
                    step={0.1}
                    onChange={(width) => onStyle({ line: { ...active.line, width } })}
                  />
                </label>
              </div>

              <Toggle
                label="显示标记点"
                checked={active.marker.visible}
                onChange={(visible) =>
                  onStyle({ marker: { ...active.marker, visible } })
                }
              />

              <div className="field-row">
                <label>
                  点形
                  <select
                    value={active.marker.shape}
                    onChange={(e) =>
                      onStyle({
                        marker: { ...active.marker, shape: e.target.value },
                      })
                    }
                  >
                    {[
                      "circle",
                      "square",
                      "triangle",
                      "diamond",
                      "cross",
                      "plus",
                      "none",
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>

                <label>
                  大小 · pt
                  <Num
                    value={active.marker.size}
                    min={1}
                    max={15}
                    onChange={(size) => onStyle({ marker: { ...active.marker, size } })}
                  />
                </label>
              </div>

              <div className="section-number">
                <Toggle
                  label="黑色描边"
                  checked={active.outline.enabled}
                  onChange={(enabled) =>
                    onStyle({ outline: { ...active.outline, enabled } })
                  }
                />

                <Num
                  value={active.outline.width}
                  min={0}
                  max={4}
                  step={0.1}
                  onChange={(width) =>
                    onStyle({ outline: { ...active.outline, width } })
                  }
                />
              </div>
            </>
          )}
        </div>
      )}
    </Group>
  );
}
