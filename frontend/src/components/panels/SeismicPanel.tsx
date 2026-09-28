import { Activity } from "lucide-react";
import { SS, VS } from "../../types";
import { Group, Num, Toggle } from "../Controls";

type Props = {
  view: VS;
  maps: Record<string, any[]>;
  /** CSS gradient preview of the active colormap. */
  preview: string;
  onSeismic: (patch: Partial<SS>) => void;
};

/** Sidebar "地震显示" group: colormap, amplitude clipping and interpolation. */
export default function SeismicPanel({ view, maps, preview, onSeismic }: Props) {
  const s = view.seismic;
  return (
    <Group icon={<Activity size={16} />} title="地震显示">
      <label className="field">
        色标
        <select
          value={s.colormap}
          onChange={(e) => onSeismic({ colormap: e.target.value })}
        >
          {Object.keys(maps).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>

      <div className="color-preview" style={{ background: preview }} />

      <div className="check-row">
        <Toggle
          label="反转色标"
          checked={s.reverse_colormap}
          onChange={(reverse_colormap) => onSeismic({ reverse_colormap })}
        />

        <Toggle
          label="反转极性"
          checked={s.reverse_polarity}
          onChange={(reverse_polarity) => onSeismic({ reverse_polarity })}
        />
      </div>

      <label className="field">
        振幅范围
        <select
          value={s.clip_mode}
          onChange={(e) => onSeismic({ clip_mode: e.target.value })}
        >
          <option value="percentile">百分位</option>
          <option value="manual">手动</option>
        </select>
      </label>

      {s.clip_mode === "percentile" ? (
        <>
          <div className="section-number">
            <span>裁剪百分位 %</span>
            <Num
              value={s.clip_percentile}
              min={0.1}
              max={100}
              step={0.1}
              onChange={(clip_percentile) => onSeismic({ clip_percentile })}
            />
          </div>

          <Toggle
            label="零中心对称"
            checked={s.symmetric}
            onChange={(symmetric) => onSeismic({ symmetric })}
          />
        </>
      ) : (
        <div className="field-row">
          <label>
            Min
            <Num value={s.vmin ?? 0} onChange={(vmin) => onSeismic({ vmin })} />
          </label>

          <label>
            Max
            <Num value={s.vmax ?? 1} onChange={(vmax) => onSeismic({ vmax })} />
          </label>
        </div>
      )}

      <div className="segmented" role="group" aria-label="插值方式">
        {(
          [
            ["nearest", "Nearest"],
            ["bilinear", "Bilinear"],
            ["bicubic", "Bicubic"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={s.interpolation === value ? "active" : ""}
            aria-pressed={s.interpolation === value}
            onClick={() => onSeismic({ interpolation: value })}
          >
            {label}
          </button>
        ))}
      </div>

      {view.view_mode === "2d" && (
        <Toggle
          label="自适应分辨率"
          checked={s.adaptive_resolution}
          onChange={(adaptive_resolution) => onSeismic({ adaptive_resolution })}
        />
      )}
    </Group>
  );
}
