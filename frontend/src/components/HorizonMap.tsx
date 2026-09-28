import ExportDialog from "./ExportDialog";
import { Layers, Palette, ScanLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Plotly from "plotly.js-dist-min";
import type { HS } from "../types";
import { Num, Toggle } from "./Controls";

type State = {
  horizon: string;
  display: string;
  colormap: string;
  reverse_colormap: boolean;
  range_mode: string;
  vmin: number | null;
  vmax: number | null;
  contours: boolean;
  interval: number;
  line_width: number;
  labels: boolean;
  colorbar: boolean;
  x_range: [number, number] | null;
  y_range: [number, number] | null;
};
type Data = {
  x: number[];
  y: number[];
  z: (number | null)[][];
  twt_range: number[];
  vmin: number;
  vmax: number;
  colorscale: any[];
  contours: { level: number; x: number[]; y: number[] }[];
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
    display: "filled_contour",
    colormap: "petrel",
    reverse_colormap: false,
    range_mode: "auto",
    vmin: null,
    vmax: null,
    contours: true,
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
  const [settings, setSettings] = useState({
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
  const patch = (p: Partial<State>) => setState((s) => ({ ...s, ...p }));
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
  const query = JSON.stringify({ ...state, x_range: null, y_range: null });
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
        const res = await fetch("/api/horizon-map", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: query,
          signal: abort.signal,
        });
        const result = await res.json();
        if (!res.ok)
          throw Error(
            typeof result.detail === "string"
              ? result.detail
              : "请检查色彩范围与等值线间隔。",
          );
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
            colorbar: { title: { text: "TWT (ms)" } },
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
              colorbar: { title: { text: "TWT (ms)" } },
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
        await Plotly.react(
          el,
          traces,
          {
            margin: { l: 70, r: 100, t: 30, b: 60 },
            showlegend: false,
            dragmode: drag,
            paper_bgcolor: "#fff",
            plot_bgcolor: "#fff",
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
  }, [data, state.x_range, state.y_range, drag]);
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
      <section className="map-control-section">
        <h3>
          <Layers size={15} />
          层位地图<span>HORIZON MAP</span>
        </h3>
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
      </section>
      <section className="map-control-section">
        <h3>
          <Palette size={15} />
          色彩映射
        </h3>
        {select(
          "色标",
          state.colormap,
          ["petrel", "turbo", "viridis", "cividis", "jet"].map((v) => [
            v,
            v[0].toUpperCase() + v.slice(1),
          ]),
          (colormap) => patch({ colormap }),
        )}
        {gradient && (
          <div className="map-color-preview" aria-label="当前色标预览">
            <div
              style={{ background: `linear-gradient(to right, ${gradient})` }}
            />
            <span>
              {data!.vmin.toFixed(1)}
              <span>TWT · ms</span>
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
              最小值 · ms
              <Num
                value={state.vmin ?? 0}
                onChange={(vmin) => patch({ vmin })}
              />
            </label>
            <label>
              最大值 · ms
              <Num
                value={state.vmax ?? 1}
                onChange={(vmax) => patch({ vmax })}
              />
            </label>
          </div>
        )}
        <Toggle
          label="显示色标尺"
          checked={state.colorbar}
          onChange={(colorbar) => patch({ colorbar })}
        />
      </section>
      <section className="map-control-section">
        <h3>
          <ScanLine size={15} />
          等值线
        </h3>
        <Toggle
          label="显示等值线"
          checked={state.contours}
          onChange={(contours) => patch({ contours })}
        />
        <fieldset
          className="map-contour-fields"
          disabled={!state.contours || state.display === "filled"}
        >
          <div className="field-row">
            <label>
              间隔 · ms
              <Num
                value={state.interval}
                min={0.01}
                step={1}
                onChange={(interval) => patch({ interval })}
              />
            </label>
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
      </section>
    </div>
  );
  const host = document.getElementById("horizon-map-controls");
  return (
    <>
      {host ? createPortal(controls, host) : controls}
      <div className="viewer-card">
        <div className="viewer-toolbar">
          <b>
            Horizon Map ·{" "}
            {horizons.find((h) => h.id === state.horizon)?.name || "请导入层位"}
          </b>
          <div className="tools">
            <button onClick={() => setDrag("zoom")}>缩放</button>
            <button onClick={() => setDrag("pan")}>平移</button>
            <button onClick={() => patch({ x_range: null, y_range: null })}>
              重置视图
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
          style={{
            height: "65vh",
            minHeight: 400,
            visibility: data ? "visible" : "hidden",
          }}
        />
      </div>
      {exportOpen && <ExportDialog title="层位地图 · Add to Export" settings={settings}
        onChange={p => setSettings(s => ({...s, ...p}))}
        onClose={onCloseExport} onExport={addToExport} busy={saving}
        disabled={!data || loading} error={error} rendering={false}
        dataset={dataset} onDataset={onDataset} datasetPlaceholder={datasetPlaceholder}
        colorbar={state.colorbar} onColorbar={colorbar => patch({colorbar})} />}

    </>
  );
}
