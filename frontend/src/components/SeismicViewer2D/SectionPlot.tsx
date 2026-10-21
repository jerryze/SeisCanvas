import { useEffect, useRef, useState } from "react";
import Plotly from "plotly.js-dist-min";
import { Meta, Section, VS } from "../../types";
import PlotScrollFrame, {
  isScrollPreview,
  updatePlotLayout,
  updatePlotData,
} from "../PlotScrollFrame";
import { ordered, type Range } from "../plotScrollMath";
import { ProbeRequest } from "../Probe";
import { buildTraces, buildLayout } from "./sectionGeometry";
import { measureSectionViewport, SectionViewport } from "./sectionDisplay";

type Props = {
  view: VS;
  section: Section;
  meta: Meta | null;
  colors: any[];
  drag: "zoom" | "pan";
  /** Merge a partial view update, exactly like the app-level state setter. */
  onPatch: (update: (v: VS) => VS) => void;
  /** Ask the backend for the original amplitude under the cursor. */
  onProbe: (request: ProbeRequest) => void;
  onError: (message: string) => void;
  /** Usable CSS plot dimensions, including the applied margins/aspect lock. */
  onViewportSize: (viewport: SectionViewport) => void;
};

/** The Plotly container for one 2D section; owns rendering and plot events. */
export default function SectionPlot({
  view,
  section,
  meta,
  colors,
  drag,
  onPatch,
  onProbe,
  onError,
  onViewportSize,
}: Props) {
  const plot = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<SectionViewport | null>(null);
  const renderedInputs = useRef<unknown[] | null>(null);
  const renderQueue = useRef(Promise.resolve());
  const viewRef = useRef(view);
  viewRef.current = view;
  const latest = useRef({ onPatch, onProbe, onError, onViewportSize });
  latest.current = { onPatch, onProbe, onError, onViewportSize };
  const positions =
    (view.view_type === "inline" ? meta?.crosslines : meta?.inlines) ||
    section.x;
  const xBounds: Range = [
    positions[0] -
      (positions.length > 1 ? (positions[1] - positions[0]) / 2 : 0.5),
    positions.at(-1)! +
      (positions.length > 1
        ? (positions.at(-1)! - positions.at(-2)!) / 2
        : 0.5),
  ];
  const time = meta?.time_range || [section.time[0], section.time.at(-1)!];

  function reportViewportSize(el: any) {
    const viewport = measureSectionViewport(el._fullLayout);
    if (viewport) {
      setViewport((current) =>
        current?.width === viewport.width && current.height === viewport.height
          ? current
          : viewport,
      );
      latest.current.onViewportSize(viewport);
    }
  }

  useEffect(() => {
    const el = plot.current as any;
    if (!el) return;

    let disposed = false;
    const layout = buildLayout(
      section,
      meta
        ? {
            ...view,
            x_range: view.x_range ?? xBounds,
            time_range: view.time_range ?? [time[0], time[1]],
          }
        : view,
      drag,
    );
    const inputs = [
      section,
      colors,
      view.seismic,
      view.horizons,
      view.view_type,
      view.section_number,
      view.smooth_horizons,
      view.horizon_sg,
      view.horizon_sg_window,
      view.smooth_horizons ? view.x_range : null,
      viewport?.width,
    ];

    renderQueue.current = renderQueue.current
      .catch(() => {})
      .then(async () => {
        if (disposed) return;
        if (
          renderedInputs.current?.every((value, i) =>
            Object.is(value, inputs[i]),
          )
        ) {
          await updatePlotLayout(el, {
            "xaxis.range": layout.xaxis.range,
            "yaxis.range": layout.yaxis.range,
            "yaxis.scaleanchor": layout.yaxis.scaleanchor,
            "yaxis.scaleratio": layout.yaxis.scaleratio,
            dragmode: drag,
          });
          return;
        }
        await updatePlotData(
          el,
          buildTraces(section, view, colors, undefined, {
            width: viewport?.width || Math.max(1, el.clientWidth - 100),
            xRange: layout.xaxis.range,
            pixelRatio: window.devicePixelRatio || 1,
          }),
          layout as any,
          {
            responsive: true,
            displayModeBar: false,
            scrollZoom: true,
          },
        );
        if (disposed) return;
        renderedInputs.current = inputs;
        reportViewportSize(el);

        el.removeAllListeners?.("plotly_relayout");
        el.removeAllListeners?.("plotly_hover");

        // The cursor readout asks the backend for the original sample; the
        // heatmap may be an interpolated render grid.
        el.on("plotly_hover", (event: any) => {
          const point = event?.points?.[0];
          if (!point) return;
          const request =
            viewRef.current.view_type === "inline"
              ? {
                  kind: "inline" as const,
                  position: viewRef.current.section_number,
                  crossline: point.x,
                  time: point.y,
                }
              : {
                  kind: "crossline" as const,
                  position: viewRef.current.section_number,
                  inline: point.x,
                  time: point.y,
                };
          latest.current.onProbe(request);
        });

        el.on("plotly_relayout", (e: any) => {
          if (isScrollPreview(el)) return;
          if (e["xaxis.autorange"] || e["yaxis.autorange"]) {
            latest.current.onPatch((v) => ({
              ...v,
              x_range: null,
              time_range: null,
            }));
            return;
          }

          if (
            e["xaxis.range[0]"] !== undefined ||
            e["yaxis.range[0]"] !== undefined
          ) {
            latest.current.onPatch((v) => ({
              ...v,
              x_range:
                e["xaxis.range[0]"] !== undefined
                  ? [e["xaxis.range[0]"], e["xaxis.range[1]"]]
                  : v.x_range,
              time_range:
                e["yaxis.range[0]"] !== undefined
                  ? [
                      Math.min(e["yaxis.range[0]"], e["yaxis.range[1]"]),
                      Math.max(e["yaxis.range[0]"], e["yaxis.range[1]"]),
                    ]
                  : v.time_range,
            }));
          }
        });
      })
      .catch((e) => {
        latest.current.onError(String(e));
      });

    return () => {
      disposed = true;
    };
  }, [section, view, colors, drag, viewport]);

  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    let disposed = false;
    const ob = new ResizeObserver(() => {
      if ((el as any).data) {
        Promise.resolve(Plotly.Plots.resize(el))
          .then(() => {
            if (!disposed) reportViewportSize(el);
          })
          .catch((e) => {
            if (!disposed) latest.current.onError(String(e));
          });
      }
    });
    ob.observe(el);
    return () => {
      disposed = true;
      ob.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = plot.current;
    return () => {
      if (el) Plotly.purge(el);
    };
  }, []);

  return (
    <PlotScrollFrame
      plotRef={plot}
      xBounds={xBounds}
      yBounds={[time[0], time[1]]}
      xLabel={view.view_type === "inline" ? "Crossline" : "Inline"}
      yLabel="Time (ms)"
      onError={onError}
      onCommit={({ x, y }) =>
        onPatch((v) => ({ ...v, x_range: x, time_range: ordered(y) }))
      }
    >
      <div ref={plot} className="plot" />
    </PlotScrollFrame>
  );
}
