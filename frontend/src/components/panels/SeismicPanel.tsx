import { Activity } from "lucide-react";
import { SS, VS } from "../../types";
import { Group, Num, Toggle, SubsectionSummary, Select } from "../Controls";
import ColormapSelect, { colormapOptions } from "../ColormapSelect";

type Props = {
  view: VS;
  maps: Record<string, any[]>;
  onSeismic: (patch: Partial<SS>) => void;
};

/** Shared controls for 2D sections, 3D slices and the map's A–B profile. */
export function SeismicSettings({ seismic: s, maps, onSeismic }: {
  seismic: SS; maps: Record<string, any[]>; onSeismic: (patch: Partial<SS>) => void;
}) {
  return (
    <>
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
            title="波形与变面积"
            hint={s.wiggle || s.variable_area ? `Gain ${s.wiggle_gain}` : "关闭"}
            tooltip="叠加原始地震道；道间隔随缩放自动调整"
          />
          <div className="subsettings-body">
            <Toggle
              label="波形（Wiggle）"
              checked={s.wiggle}
              onChange={(wiggle) => onSeismic({ wiggle })}
            />
            <Toggle
              label="正振幅填充（Variable Area）"
              checked={s.variable_area}
              onChange={(variable_area) => onSeismic({ variable_area })}
            />
            <label className="section-number">
              <span>增益 Gain</span>
              <Num
                label="波形与填充增益"
                title="横向振幅缩放，1.0 为默认增益"
                value={s.wiggle_gain}
                min={0}
                max={100}
                step={0.1}
                disabled={!s.wiggle && !s.variable_area}
                onChange={(wiggle_gain) => onSeismic({ wiggle_gain })}
              />
            </label>
            <label className="field">
              填充颜色
              <input
                type="color"
                aria-label="变面积填充颜色"
                value={s.variable_area_color}
                disabled={!s.variable_area}
                onChange={(e) => onSeismic({ variable_area_color: e.target.value })}
              />
            </label>
          </div>
        </details>

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


              <Toggle
                label="背景插值"
                title="Sinc8 插值；关闭后直接显示原始采样单元"
                checked={s.background_interpolation}
                onChange={(background_interpolation) => onSeismic({ background_interpolation })}
              />
              <Toggle
                label="Wiggle 插值"
                title={s.wiggle || s.variable_area
                  ? "仅影响波形线与正振幅填充：开启使用 Sinc8，关闭连接原始采样点；放大时间轴可观察差异"
                  : "先开启波形（Wiggle）或正振幅填充；此开关不影响彩色背景"}
                disabled={!s.wiggle && !s.variable_area}
                checked={s.wiggle_interpolation}
                onChange={(wiggle_interpolation) => onSeismic({ wiggle_interpolation })}
              />
        </div>
      </details>
    </>
  );
}

/** Sidebar container; all section renderers edit the same seismic state. */
export default function SeismicPanel({ view, maps, onSeismic }: Props) {
  return <Group icon={<Activity size={16} />} title="地震显示" defaultOpen={view.view_mode === "2d"}>
    <SeismicSettings seismic={view.seismic} maps={maps} onSeismic={onSeismic} />
  </Group>;
}
