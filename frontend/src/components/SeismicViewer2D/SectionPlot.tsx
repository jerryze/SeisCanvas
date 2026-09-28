import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";
import { Section, VS } from "../../types";
import { ProbeRequest } from "../Probe";
import { buildTraces, buildLayout } from "./sectionGeometry";

type Props = {
  view: VS;
  section: Section;
  colors: any[];
  drag: "zoom" | "pan";
  /** Merge a partial view update, exactly like the app-level state setter. */
  onPatch: (update: (v: VS) => VS) => void;
  /** Ask the backend for the original amplitude under the cursor. */
  onProbe: (request: ProbeRequest) => void;
  onError: (message: string) => void;
};

/** The Plotly container for one 2D section; owns rendering and plot events. */
export default function SectionPlot({
  view,
  section,
  colors,
  drag,
  onPatch,
  onProbe,
  onError,
}: Props) {
  const plot = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const latest = useRef({ onPatch, onProbe, onError });
  latest.current = { onPatch, onProbe, onError };

  useEffect(() => {
    const el = plot.current as any;
    if (!el) return;

    let disposed = false;

    Plotly.react(
      el,
      buildTraces(section, view, colors),
      buildLayout(section, view, drag) as any,
      {
        responsive: true,
        displayModeBar: false,
        scrollZoom: true,
      },
    )
      .then(() => {
        if (disposed) return;

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
  }, [section, view, colors, drag]);

  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const ob = new ResizeObserver(() => {
      if ((el as any).data) {
        Plotly.Plots.resize(el);
      }
    });
    ob.observe(el);
    return () => ob.disconnect();
  }, []);

  useEffect(() => {
    const el = plot.current;
    return () => {
      if (el) Plotly.purge(el);
    };
  }, []);

  return <div ref={plot} className="plot" />;
}
