import { Activity } from "lucide-react";
import { SS, VS } from "../../types";
import { Group, Num, Toggle, SubsectionSummary, Select } from "../Controls";
import ColormapSelect, { colormapOptions } from "../ColormapSelect";

type Props = {
  view: VS;
  maps: Record<string, any[]>;
  onSeismic: (patch: Partial<SS>) => void;
};

/** Sidebar "地震显示" group: colormap, amplitude clipping and interpolation. */
export default function SeismicPanel({
  view,
  maps,
  onSeismic,
}: Props) {
  const s = view.seismic;
  return (
    <Group
      icon={<Activity size={16} />}
      title="地震显示"
      defaultOpen={view.view_mode === "2d"}
    >
      <ColormapSelect label="色标" value={s.colormap} options={colormapOptions(maps)} reverse={s.reverse_colormap} onChange={(colormap) => onSeismic({ colormap })} />

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

      <details className="subsettings">
        <SubsectionSummary
          title="振幅与采样"
          hint={s.clip_mode === "percentile" ? `${s.clip_percentile}%` : "手动范围"}
        />
        <div className="subsettings-body">
          <label className="field">
            振幅范围
            <Select
              value={s.clip_mode}
              onChange={(e) => onSeismic({ clip_mode: e.target.value })}
            >
              <option value="percentile">百分位</option>
              <option value="manual">手动</option>
            </Select>
          </label>

          {s.clip_mode === "percentile" ? (
            <>
              <div className="section-number">
                <span>裁剪百分位 %</span>
                <Num
                  label="裁剪百分位"
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
                最小值
                <Num
                  value={s.vmin ?? 0}
                  onChange={(vmin) => onSeismic({ vmin })}
                />
              </label>

              <label>
                最大值
                <Num
                  value={s.vmax ?? 1}
                  onChange={(vmax) => onSeismic({ vmax })}
                />
              </label>
            </div>
          )}

          <div className="segmented" role="group" aria-label="插值方式">
            {(
              [
                ["nearest", "最近邻"],
                ["bilinear", "双线性"],
                ["bicubic", "双三次"],
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
              onChange={(adaptive_resolution) =>
                onSeismic({ adaptive_resolution })
              }
            />
          )}
        </div>
      </details>
    </Group>
  );
}
