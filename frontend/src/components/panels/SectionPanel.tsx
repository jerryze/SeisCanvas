import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { Meta, VS } from "../../types";
import { Group, Num, Toggle } from "../Controls";

type Props = {
  view: VS;
  sections: number[];
  busy: string;
  meta: Meta | null;
  onMode: (mode: "inline" | "crossline") => void;
  onSection: (n: number) => void;
  onPatch: (update: (v: VS) => VS) => void;
};

export function SectionNavigation({
  sections,
  value,
  disabled,
  onChange,
}: {
  sections: number[];
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const index = sections.indexOf(value);
  return (
    <div className="section-navigation" role="group" aria-label="切换剖面">
      <button
        className="icon"
        title="上一剖面（Alt+←）"
        disabled={disabled || index <= 0}
        onClick={() => onChange(sections[index - 1])}
      >
        <ChevronLeft size={16} />
      </button>
      <span aria-label="剖面位置">
        {index < 0 ? "—" : index + 1} / {sections.length}
      </span>
      <button
        className="icon"
        title="下一剖面（Alt+→）"
        disabled={disabled || index < 0 || index >= sections.length - 1}
        onClick={() => onChange(sections[index + 1])}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

/** Sidebar "剖面" group: view type, aspect lock and section selector. */
export default function SectionPanel({
  view,
  sections,
  busy,
  meta,
  onMode,
  onSection,
  onPatch,
}: Props) {
  return (
    <Group icon={<SlidersHorizontal size={16} />} title="剖面">
      <div className="segmented" role="group" aria-label="剖面方向">
        {(["inline", "crossline"] as const).map((m) => (
          <button
            key={m}
            className={view.view_type === m ? "active" : ""}
            aria-pressed={view.view_type === m}
            disabled={!meta || !!busy}
            onClick={() => onMode(m)}
          >
            {m === "inline" ? "Inline" : "Crossline"}
          </button>
        ))}
      </div>

      <div className="range-number" role="group" aria-label="剖面位置">
        <span>编号</span>
        <input
          aria-label="剖面滑块"
          type="range"
          disabled={!meta || !!busy}
          min={0}
          max={Math.max(0, sections.length - 1)}
          value={Math.max(0, sections.indexOf(view.section_number))}
          onChange={(e) => onSection(sections[+e.target.value])}
        />
        <Num
          label="剖面编号"
          disabled={!meta || !!busy}
          value={view.section_number}
          onChange={onSection}
          min={sections[0]}
          max={sections.at(-1)}
        />
      </div>

      <div className="section-number" role="group" aria-label="剖面横纵比">
        <Toggle
          label="固定横纵比"
          title="固定横向与纵向的比例；取消后自动适应视图"
          checked={!!view.aspect_ratio_2d}
          onChange={(enabled) =>
            onPatch((v) => ({ ...v, aspect_ratio_2d: enabled ? [2, 1] : null }))
          }
        />
        <Num
          label="横纵比（横÷纵）"
          title="横÷纵，例如 2 表示 2:1"
          disabled={!view.aspect_ratio_2d}
          value={view.aspect_ratio_2d
            ? Number((view.aspect_ratio_2d[0] / view.aspect_ratio_2d[1]).toFixed(6))
            : 2}
          min={0.02}
          max={50}
          step={0.1}
          onChange={(ratio) =>
            onPatch((v) => ({
              ...v,
              // Keep both stored components within the existing 0.1–5 bounds.
              aspect_ratio_2d: ratio >= 1 ? [5, 5 / ratio] : [5 * ratio, 5],
            }))
          }
        />
      </div>
    </Group>
  );
}
