import ExportDialog from "./ExportDialog";
import { Layers, MousePointer2, Move, Palette, RotateCcw, ScanLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Plotly from "plotly.js-dist-min";
import type { HS } from "../types";
import type { ExportDialogSettings } from "../types";
import { api } from "../api/client";
import { formatAmplitude } from "../format";
import { Group, Num, Toggle } from "./Controls";

type State = {
  horizon: string;
  color_by: "twt" | "amplitude" | "difference";
  display: string;
  colormap: string;
  reverse_colormap: boolean;
  range_mode: string;
  vmin: number | null;
  vmax: number | null;
  clip_percentile: number;
  difference_reference: string | null;
  difference_comparison: string | null;
  difference_type: "signed" | "absolute";
  show_statistics: boolean;
  contours: boolean;
  interval_auto: boolean;
  interval: number;
  line_width: number;
  labels: boolean;
  colorbar: boolean;
  x_range: [number, number] | null;
  y_range: [number, number] | null;
};
type ProfileCurve = { role: string; name: string; values: (number | null)[] };
type ProfileData = {
  distance: number[];
  curves: ProfileCurve[];
  label_y: string;
  a: number[];
  b: number[];
};
type DifferenceStats = {
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  valid_ratio: number;
  count: number;
};
type Data = {
  x: number[];
  y: number[];
  z: (number | null)[][];
  colorbar_title?: string;
  scalar_name?: string;
  scalar_unit?: string;
  twt_range: number[];
  vmin: number;
  vmax: number;
  colorscale: any[];
  contours: { level: number; x: number[]; y: number[] }[];
  statistics?: DifferenceStats;
};
export default function HorizonMap({
  horizons,
  exportOpen,
  onCloseExport,
  onReady,
  dataset,
  datasetPlaceholder,
  onDataset,
  onAddToExport,
}: {
  horizons: HS[];
  exportOpen: boolean;
  onCloseExport: () => void;
  onReady: (v: boolean) => void;
  dataset: string;
  datasetPlaceholder?: string;
  onDataset: (value: string) => void;
  onAddToExport: (payload: { state: State; settings: Record<string, unknown> }) => Promise<void>;
}) {
  const [state, setState] = useState<State>({
    horizon: horizons[0]?.id || "",
    color_by: "twt",
    difference_reference: null,
    difference_comparison: null,
    difference_type: "signed",
    show_statistics: true,
    display: "filled_contour",
    colormap: "petrel",
    reverse_colormap: false,
    range_mode: "auto",
    vmin: null,
    vmax: null,
    clip_percentile: 99,
    contours: true,
    interval_auto: true,
    interval: 10,
    line_width: 0.5,
    labels: false,
    colorbar: true,
    x_range: null,
    y_range: null,
  });
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [drag, setDrag] = useState<"zoom" | "pan">("zoom");
  const [settings, setSettings] = useState<ExportDialogSettings>({
    format: "png",
    width: 180,
    height: 140,
    dpi: 300,
    font: "Times New Roman",
    font_size: 10,
    show_axes: true,
    show_labels: true,
    show_title: true,
  });
  const plot = useRef<HTMLDivElement>(null),
    queue = useRef(Promise.resolve()),
    version = useRef(0),
    latest = useRef(state);
  latest.current = state;
  const [profileOn, setProfileOn] = useState(false);
  const [profileA, setProfileA] = useState<[number, number] | null>(null);
  const [profileB, setProfileB] = useState<[number, number] | null>(null);
  const [picking, setPicking] = useState<null | "a" | "b">(null);
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [profileError, setProfileError] = useState("");
  const profileRef = useRef<HTMLDivElement>(null);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const patch = (p: Partial<State>) => setState((s) => ({ ...s, ...p }));
  const centerInline = Math.round(((data?.y[0] ?? 0) + (data?.y.at(-1) ?? 0)) / 2);
  const centerCrossline = Math.round(((data?.x[0] ?? 0) + (data?.x.at(-1) ?? 0)) / 2);
  const setPoint = (
    setter: (p: [number, number] | null) => void,
    point: [number, number] | null,
    index: 0 | 1,
    value: number,
  ) => {
    const base: [number, number] = point ?? [centerInline, centerCrossline];
    const next = [...base] as [number, number];
    next[index] = value;
    setter(next);
  };
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    if (!horizons.some((h) => h.id === state.horizon)) {
      patch({
        horizon: horizons[0]?.id || "",
        range_mode: "auto",
        vmin: null,
        vmax: null,
        x_range: null,
        y_range: null,
      });
      setData(null);
    }
  }, [horizons, state.horizon]);
  const query = JSON.stringify({
    ...state,
    interval: state.interval_auto ? null : state.interval,
    x_range: null,
    y_range: null,
  });
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    version.current++;
    ready.current(false);
    setData(null);
    setLoading(!!state.horizon);
    if (!state.horizon) return;
    const timer = setTimeout(async () => {
      try {
        const res = await api(
          "/horizon-map",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: query,
            signal: abort.signal,
          },
          "请检查色彩范围与等值线间隔。",
        );
        const result = await res.json();
        if (active) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (active && (e as Error).name !== "AbortError")
          setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    }, 160);
    return () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
  }, [query]);
  useEffect(() => {
    const el = plot.current as any;
    if (!el || !data) return;
    const token = ++version.current;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (token !== version.current) return;
        el.removeAllListeners?.("plotly_relayout");
        const traces: any[] = [];
        if (state.display !== "contour")
          traces.push({
            type: "heatmap",
            x: data.x,
            y: data.y,
            z: data.z,
            zmin: data.vmin,
            zmax: data.vmax,
            colorscale: data.colorscale,
            showscale: state.colorbar,
            colorbar: { title: { text: data.colorbar_title || "TWT (ms)" } },
            zsmooth: false,
            connectgaps: false,
            hoverongaps: false,
            hovertemplate:
              "Inline: %{y}<br>Crossline: %{x}<br>TWT: %{z:.2f} ms<extra></extra>",
          });
        else
          traces.push({
            type: "scatter",
            x: [null],
            y: [null],
            mode: "markers",
            marker: {
              color: [data.vmin],
              cmin: data.vmin,
              cmax: data.vmax,
              colorscale: data.colorscale,
              showscale: state.colorbar,
              colorbar: { title: { text: data.colorbar_title || "TWT (ms)" } },
            },
            hoverinfo: "skip",
          });
        const cx: (number | null)[] = [],
          cy: (number | null)[] = [],
          values: (number | null)[] = [];
        const lx: number[] = [],
          ly: number[] = [],
          labels: string[] = [];
        for (const line of data.contours) {
          for (let j = 0; j < line.x.length; j++) {
            cx.push(line.x[j]);
            cy.push(line.y[j]);
            values.push(line.level);
          }
          cx.push(null);
          cy.push(null);
          values.push(null);
          if (line.x.length > 2) {
            const i = Math.floor(line.x.length / 2);
            lx.push(line.x[i]);
            ly.push(line.y[i]);
            labels.push(String(line.level));
          }
        }
        traces.push({
          type: "scatter",
          mode: "lines",
          x: cx,
          y: cy,
          customdata: values,
          line: { color: "#333333", width: (state.line_width * 4) / 3 },
          connectgaps: false,
          hovertemplate:
            "Inline: %{y}<br>Crossline: %{x}<br>TWT: %{customdata} ms<extra></extra>",
        });
        if (state.labels)
          traces.push({
            type: "scatter",
            mode: "text",
            x: lx,
            y: ly,
            text: labels,
            textfont: { size: 11, color: "#333" },
            hoverinfo: "skip",
          });
        if (profileOn && profileA && profileB) {
          traces.push({
            type: "scatter",
            mode: "lines+markers+text",
            x: [profileA[1], profileB[1]],
            y: [profileA[0], profileB[0]],
            text: ["A", "B"],
            textposition: "bottom center",
            textfont: { size: 11, color: "#365985" },
            line: { color: "#365985", width: 2, dash: "dash" },
            marker: { color: "#365985", size: 7 },
            connectgaps: true,
            hoverinfo: "skip",
            showlegend: false,
          });
        }
        await Plotly.react(
          el,
          traces,
          {
            margin: { l: 70, r: 100, t: 30, b: 60 },
            showlegend: false,
            dragmode: drag,
            paper_bgcolor: "#fff",
            plot_bgcolor: "#fff",
            font: { family: "DM Sans, 'PingFang SC', Arial, sans-serif", color: "#425367", size: 11 },
            xaxis: {
              title: { text: "Crossline" },
              range: state.x_range || [data.x[0] - 0.5, data.x.at(-1)! + 0.5],
              constrain: "domain",
              showgrid: false,
            },
            yaxis: {
              title: { text: "Inline" },
              range: state.y_range || [data.y[0] - 0.5, data.y.at(-1)! + 0.5],
              scaleanchor: "x",
              scaleratio: 1,
              constrain: "domain",
              showgrid: false,
            },
          } as any,
          { responsive: true, scrollZoom: true, displayModeBar: false },
        );
        if (token !== version.current) return;
        // Profile picking: the next map click lands on A, the one after on B.
        el.on("plotly_click", (event: any) => {
          const target = pickingRef.current;
          const point = event?.points?.[0];
          if (!target || !point) return;
          const pos: [number, number] = [point.y, point.x];
          if (target === "a") {
            setProfileA(pos);
            setPicking("b");
          } else {
            setProfileB(pos);
            setPicking(null);
          }
        });
        el.on("plotly_relayout", (e: any) => {
          if (e["xaxis.autorange"] || e["yaxis.autorange"])
            patch({ x_range: null, y_range: null });
          else if (
            e["xaxis.range[0]"] !== undefined ||
            e["yaxis.range[0]"] !== undefined
          )
            patch({
              x_range:
                e["xaxis.range[0]"] !== undefined
                  ? [e["xaxis.range[0]"], e["xaxis.range[1]"]]
                  : latest.current.x_range,
              y_range:
                e["yaxis.range[0]"] !== undefined
                  ? [e["yaxis.range[0]"], e["yaxis.range[1]"]]
                  : latest.current.y_range,
            });
        });
        ready.current(true);
      })
      .catch((e) => {
        setError(String(e));
        ready.current(false);
      });
  }, [data, state.x_range, state.y_range, drag, profileOn, profileA, profileB]);
  // A–B profile: refetch whenever the endpoints or the active scalars change.
  useEffect(() => {
    if (!profileOn || !profileA || !profileB) {
      setProfileData(null);
      setProfileError("");
      return;
    }
    if (profileA[0] === profileB[0] && profileA[1] === profileB[1]) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await api("/horizon-map/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: latest.current, a: profileA, b: profileB }),
          signal: abort.signal,
        });
        const result = await res.json();
        setProfileData(result);
        setProfileError("");
      } catch (e) {
        if ((e as Error).name !== "AbortError")
          setProfileError((e as Error).message);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [profileOn, profileA, profileB, query]);

  // Profile subplot below the map: hover, zoom, double-click to reset.
  useEffect(() => {
    const el = profileRef.current as any;
    if (!el || !profileData) return;
    const colors = ["#365985", "#c45252"];
    const traces: any[] = profileData.curves.map((c, i) => ({
      type: "scatter",
      mode: "lines",
      name: c.name,
      x: profileData.distance,
      y: c.values,
      connectgaps: false,
      line: { color: colors[i % colors.length], width: 2 },
      hovertemplate: `${c.name}<br>距离 %{x:.1f}<br>%{y}<extra></extra>`,
    }));
    Plotly.react(
      el,
      traces,
      {
        margin: { l: 62, r: 14, t: 8, b: 38 },
        showlegend: profileData.curves.length > 1,
        legend: { orientation: "h", y: -0.25 },
        paper_bgcolor: "#fff",
        plot_bgcolor: "#fff",
        font: { family: "DM Sans, 'PingFang SC', Arial, sans-serif", color: "#425367", size: 11 },
        xaxis: { title: { text: "距离 (网格)", standoff: 8 }, showgrid: false, linecolor: "#bcc8cf", ticks: "outside" },
        yaxis: { title: { text: profileData.label_y, standoff: 4 }, showgrid: false, linecolor: "#bcc8cf", ticks: "outside" },
        hovermode: "closest",
      } as any,
      { responsive: true, displayModeBar: false, scrollZoom: true },
    );
  }, [profileData]);

  useEffect(() => {
    if (!profileOn) return;
    const el = profileRef.current;
    return () => {
      if (el) Plotly.purge(el);
    };
  }, [profileOn]);

  useEffect(() => {
    const el = plot.current!;
    const observer = new ResizeObserver(() => {
      if ((el as any).data) Plotly.Plots.resize(el);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      version.current++;
      queue.current.finally(() => Plotly.purge(el));
      ready.current(false);
    };
  }, []);
  async function addToExport() {
    setSaving(true);
    try {
      await onAddToExport({ state, settings });
      setError("");
      onCloseExport();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const select = (
    label: string,
    value: string,
    options: [string, string][],
    change: (s: string) => void,
  ) => (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => change(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  const gradient = data?.colorscale
    .map(([position, color]) => `${color} ${position * 100}%`)
    .join(",");
  const controls = (
    <div className="map-controls">
      <Group icon={<Layers size={16} />} title="层位地图">
        {select(
          "当前层位",
          state.horizon,
          horizons.map((h) => [h.id, h.name]),
          (horizon) =>
            patch({
              horizon,
              range_mode: "auto",
              vmin: null,
              vmax: null,
              x_range: null,
              y_range: null,
            }),
        )}
        {select(
          "颜色变量",
          state.color_by,
          [
            ["twt", "TWT"],
            ["amplitude", "沿层振幅"],
            ["difference", "差值"],
          ],
          (color_by) => {
            const next: Partial<State> = {
              color_by: color_by as State["color_by"],
              range_mode: "auto",
              vmin: null,
              vmax: null,
              interval_auto: true,
            };
            if (color_by === "amplitude") next.colormap = "seismic";
            else if (color_by === "difference") {
              next.colormap = "RdBu";
              next.difference_type = "signed";
              next.difference_reference = latest.current.horizon;
              next.difference_comparison =
                horizons.find((h) => h.id !== latest.current.horizon)?.id ??
                latest.current.horizon;
            } else next.colormap = "petrel";
            patch(next);
          },
        )}
        {state.color_by === "difference" && (
          <>
            {select(
              "参考层位",
              state.difference_reference ?? "",
              horizons.map((h) => [h.id, h.name]),
              (difference_reference) => patch({ difference_reference }),
            )}
            {select(
              "对比层位",
              state.difference_comparison ?? "",
              horizons.map((h) => [h.id, h.name]),
              (difference_comparison) => patch({ difference_comparison }),
            )}
            <label className="map-field-label">差值类型</label>
            <div className="map-display-options" role="group" aria-label="差值类型">
              {(
                [
                  ["signed", "有符号"],
                  ["absolute", "绝对值"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={state.difference_type === value ? "active" : ""}
                  aria-pressed={state.difference_type === value}
                  onClick={() =>
                    patch({
                      difference_type: value,
                      colormap: value === "absolute" ? "viridis" : "RdBu",
                      range_mode: "auto",
                      vmin: null,
                      vmax: null,
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <Toggle
              label="显示统计"
              checked={state.show_statistics}
              onChange={(show_statistics) => patch({ show_statistics })}
            />
          </>
        )}
        <div className="map-range-summary">
          <span>
            层位时间范围 <small>ms</small>
          </span>
          <strong>
            {data
              ? `${data.twt_range[0].toFixed(1)} — ${data.twt_range[1].toFixed(1)}`
              : "—"}
          </strong>
        </div>
        {state.color_by === "difference" &&
          state.show_statistics &&
          data?.statistics && (
            <div className="map-stats" role="status" aria-label="差值统计">
              <span>
                MAE
                <b>
                  {data.statistics.mae === null
                    ? "—"
                    : `${formatAmplitude(data.statistics.mae)} ms`}
                </b>
              </span>
              <span>
                RMSE
                <b>
                  {data.statistics.rmse === null
                    ? "—"
                    : `${formatAmplitude(data.statistics.rmse)} ms`}
                </b>
              </span>
              <span>
                Bias
                <b>
                  {data.statistics.bias === null
                    ? "—"
                    : `${formatAmplitude(data.statistics.bias)} ms`}
                </b>
              </span>
              <span>
                有效率
                <b>{(data.statistics.valid_ratio * 100).toFixed(1)}%</b>
              </span>
            </div>
          )}
        <label className="map-field-label">显示方式</label>
        <div
          className="map-display-options"
          role="group"
          aria-label="地图显示方式"
        >
          {[
            ["filled", "填色"],
            ["contour", "等值线"],
            ["filled_contour", "叠加"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={state.display === value ? "active" : ""}
              aria-pressed={state.display === value}
              onClick={() => patch({ display: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <Toggle
          label="A–B 剖面"
          checked={profileOn}
          onChange={(value) => {
            setProfileOn(value);
            setPicking(null);
          }}
        />
        {profileOn && (
          <div className="map-profile-controls">
            <div className="field-row">
              <label>
                A · Inline
                <Num
                  value={profileA?.[0] ?? centerInline}
                  onChange={(v) => setPoint(setProfileA, profileA, 0, v)}
                />
              </label>
              <label>
                A · Xline
                <Num
                  value={profileA?.[1] ?? centerCrossline}
                  onChange={(v) => setPoint(setProfileA, profileA, 1, v)}
                />
              </label>
            </div>
            <div className="field-row">
              <label>
                B · Inline
                <Num
                  value={profileB?.[0] ?? centerInline}
                  onChange={(v) => setPoint(setProfileB, profileB, 0, v)}
                />
              </label>
              <label>
                B · Xline
                <Num
                  value={profileB?.[1] ?? centerCrossline}
                  onChange={(v) => setPoint(setProfileB, profileB, 1, v)}
                />
              </label>
            </div>
            <div className="map-profile-actions">
              <button
                className={picking === "a" ? "active" : ""}
                disabled={!data}
                onClick={() => setPicking(picking === "a" ? null : "a")}
              >
                拾取 A
              </button>
              <button
                className={picking === "b" ? "active" : ""}
                disabled={!data}
                onClick={() => setPicking(picking === "b" ? null : "b")}
              >
                拾取 B
              </button>
              <button
                onClick={() => {
                  setProfileA(null);
                  setProfileB(null);
                  setPicking(null);
                  setProfileData(null);
                  setProfileError("");
                }}
              >
                清除
              </button>
            </div>
          </div>
        )}
      </Group>
      <Group icon={<Palette size={16} />} title="色彩映射">
        {select(
          "色标",
          state.colormap,
          (state.color_by === "amplitude"
            ? [
                ["seismic", "Seismic"],
                ["RdBu", "RdBu"],
                ["coolwarm", "Coolwarm"],
              ]
            : state.color_by === "difference"
              ? state.difference_type === "absolute"
                ? [
                    ["viridis", "Viridis"],
                    ["turbo", "Turbo"],
                    ["magma", "Magma"],
                  ]
                : [
                    ["RdBu", "RdBu"],
                    ["coolwarm", "Coolwarm"],
                    ["seismic", "Seismic"],
                  ]
              : [
                  ["petrel", "Petrel"],
                  ["turbo", "Turbo"],
                  ["viridis", "Viridis"],
                  ["cividis", "Cividis"],
                  ["jet", "Jet"],
                ]) as [string, string][],
          (colormap) => patch({ colormap }),
        )}
        {gradient && (
          <div className="map-color-preview" aria-label="当前色标预览">
            <div
              style={{ background: `linear-gradient(to right, ${gradient})` }}
            />
            <span>
              {data!.vmin.toFixed(1)}
              <span>
                {data
                  ? `${data.scalar_name || "TWT"}${data.scalar_unit ? ` · ${data.scalar_unit}` : ""}`
                  : "TWT · ms"}
              </span>
              {data!.vmax.toFixed(1)}
            </span>
          </div>
        )}
        <Toggle
          label="反转色标"
          checked={state.reverse_colormap}
          onChange={(reverse_colormap) => patch({ reverse_colormap })}
        />
        <div className="map-range-mode">
          <span>颜色范围</span>
          <div
            className="map-display-options"
            role="group"
            aria-label="颜色范围"
          >
            {[
              ["auto", "自动"],
              ["manual", "手动"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={state.range_mode === value ? "active" : ""}
                aria-pressed={state.range_mode === value}
                onClick={() =>
                  patch({
                    range_mode: value,
                    vmin: data?.vmin ?? 0,
                    vmax: data?.vmax ?? 1,
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {state.range_mode === "manual" && (
          <div className="field-row">
            <label>
              最小值{state.color_by === "amplitude" ? "" : " · ms"}
              <Num
                value={state.vmin ?? 0}
                onChange={(vmin) => patch({ vmin })}
              />
            </label>
            <label>
              最大值{state.color_by === "amplitude" ? "" : " · ms"}
              <Num
                value={state.vmax ?? 1}
                onChange={(vmax) => patch({ vmax })}
              />
            </label>
          </div>
        )}
        {state.color_by === "amplitude" && state.range_mode === "auto" && (
          <div className="section-number">
            <span>裁剪百分位 %</span>
            <Num
              value={state.clip_percentile}
              min={0.1}
              max={100}
              step={0.1}
              onChange={(clip_percentile) => patch({ clip_percentile })}
            />
          </div>
        )}
        <Toggle
          label="显示色标尺"
          checked={state.colorbar}
          onChange={(colorbar) => patch({ colorbar })}
        />
      </Group>
      <Group icon={<ScanLine size={16} />} title="等值线">
        <Toggle
          label="显示等值线"
          checked={state.contours}
          onChange={(contours) => patch({ contours })}
        />
        <fieldset
          className="map-contour-fields"
          disabled={!state.contours || state.display === "filled"}
        >
          <Toggle
            label="自动间隔"
            checked={state.interval_auto}
            onChange={(interval_auto) => patch({ interval_auto })}
          />
          <div className="field-row">
            {!state.interval_auto && (
              <label>
                间隔{state.color_by === "amplitude" ? "" : " · ms"}
                <Num
                  value={state.interval}
                  min={0.01}
                  step={1}
                  onChange={(interval) => patch({ interval })}
                />
              </label>
            )}
            <label>
              线宽 · pt
              <Num
                value={state.line_width}
                min={0.1}
                max={6}
                step={0.1}
                onChange={(line_width) => patch({ line_width })}
              />
            </label>
          </div>
          <Toggle
            label="显示数值标签"
            checked={state.labels}
            onChange={(labels) => patch({ labels })}
          />
        </fieldset>
      </Group>
    </div>
  );
  const host = document.getElementById("horizon-map-controls");
  return (
    <>
      {host ? createPortal(controls, host) : controls}
      <div className="viewer-card">
        <div className="viewer-toolbar">
          <b>
            层位地图 ·{" "}
            {horizons.find((h) => h.id === state.horizon)?.name || "请导入层位"}
          </b>
          <div className="tools">
            <button
              title="框选缩放"
              className={`icon ` + `${drag === "zoom" ? "chosen" : ""}`}
              onClick={() => setDrag("zoom")}
            >
              <MousePointer2 size={16} />
            </button>

            <button
              title="平移"
              className={`icon ` + `${drag === "pan" ? "chosen" : ""}`}
              onClick={() => setDrag("pan")}
            >
              <Move size={16} />
            </button>

            <span className="divider" />

            <button
              className="reset"
              onClick={() => patch({ x_range: null, y_range: null })}
            >
              <RotateCcw size={14} />
              重置
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {loading && <p>正在绘制层位地图…</p>}
        <div
          ref={plot}
          className="map-plot"
          style={{
            visibility: data ? "visible" : "hidden",
          }}
        />
        {profileOn && (
          <div className="map-profile">
            <div className="map-profile-head">
              <b>A–B 剖面</b>
              <span>
                {picking
                  ? picking === "a"
                    ? "在地图上点击 A 点…"
                    : "在地图上点击 B 点…"
                  : profileData
                    ? `${profileData.curves.length} 条曲线 · ${profileData.curves[0]?.values.filter((v) => v !== null).length ?? 0} 有效采样`
                    : ""}
              </span>
            </div>
            {profileError && (
              <p role="alert" className="error">
                {profileError}
              </p>
            )}
            <div ref={profileRef} className="map-profile-plot" />
            {!profileData && !profileError && (
              <p className="map-profile-hint">
                在地图上拾取 A、B 两点，或在左侧手动输入坐标后自动绘制。
              </p>
            )}
          </div>
        )}
      </div>
      {exportOpen && <ExportDialog title="层位地图 · 加入导出" settings={settings}
        onChange={p => setSettings(s => ({...s, ...p}))}
        onClose={onCloseExport} onExport={addToExport} busy={saving}
        disabled={!data || loading} error={error} rendering={false}
        dataset={dataset} onDataset={onDataset} datasetPlaceholder={datasetPlaceholder}
        colorbar={state.colorbar} onColorbar={colorbar => patch({colorbar})} />}

    </>
  );
}
