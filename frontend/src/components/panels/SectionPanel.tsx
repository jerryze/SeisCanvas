import { SlidersHorizontal } from "lucide-react";
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
      <div className="segmented">
        {(["inline", "crossline"] as const).map((m) => (
          <button
            key={m}
            className={view.view_type === m ? "active" : ""}
            disabled={!meta || !!busy}
            onClick={() => onMode(m)}
          >
            {m === "inline" ? "Inline" : "Crossline"}
          </button>
        ))}
      </div>

      <Toggle
        label="固定横纵比例"
        checked={!!view.aspect_ratio_2d}
        onChange={(enabled) =>
          onPatch((v) => ({
            ...v,
            aspect_ratio_2d: enabled ? [2, 1] : null,
          }))
        }
      />
      {view.aspect_ratio_2d && (
        <div className="field-row">
          {["横向比例", "纵向比例"].map((label, index) => (
            <label key={label}>
              {label}
              <Num
                value={view.aspect_ratio_2d![index]}
                min={0.1}
                max={5}
                step={0.1}
                onChange={(n) =>
                  onPatch((v) => {
                    const ratio: [number, number] = [
                      ...(v.aspect_ratio_2d || [2, 1]),
                    ];
                    ratio[index] = n;
                    return { ...v, aspect_ratio_2d: ratio };
                  })
                }
              />
            </label>
          ))}
        </div>
      )}

      <div className="section-number">
        <span>剖面编号</span>
        <Num value={view.section_number} onChange={onSection} min={sections[0]} max={sections.at(-1)} />
      </div>

      <input
        aria-label="剖面滑块"
        type="range"
        disabled={!meta || !!busy}
        min={0}
        max={Math.max(0, sections.length - 1)}
        value={Math.max(0, sections.indexOf(view.section_number))}
        onChange={(e) => onSection(sections[+e.target.value])}
      />

      <div className="range-labels">
        <span>{sections[0] ?? "—"}</span>
        <span>{sections.at(-1) ?? "—"}</span>
      </div>
    </Group>
  );
}
