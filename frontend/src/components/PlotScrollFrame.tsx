import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Plotly from "plotly.js-dist-min";
import {
  ordered,
  scrollMetrics,
  scrollWindow,
  type Range,
} from "./plotScrollMath";
import "./plotScrollFrame.css";
import { layoutPatch } from "./loadedRaster";

const previews = new WeakMap<object, number>();
/** Preview relayouts must not trigger data requests or workspace saves. */
export const isScrollPreview = (plot: object) => previews.has(plot);
export async function updatePlotData(
  plot: any,
  traces: any[],
  layout: any,
  config: any,
) {
  previews.set(plot, (previews.get(plot) ?? 0) + 1);
  try {
    await Plotly.react(plot, traces, layout, config);
  } finally {
    const remaining = (previews.get(plot) ?? 1) - 1;
    if (remaining) previews.set(plot, remaining);
    else previews.delete(plot);
  }
}
export async function updatePlotLayout(
  plot: any,
  requested: Record<string, any>,
) {
  const patch = layoutPatch(plot._fullLayout, requested);
  if (!Object.keys(patch).length) return;
  previews.set(plot, (previews.get(plot) ?? 0) + 1);
  try {
    await Plotly.relayout(plot, patch);
  } finally {
    const remaining = (previews.get(plot) ?? 1) - 1;
    if (remaining) previews.set(plot, remaining);
    else previews.delete(plot);
  }
}
type Axes = { x: Range; y: Range };

export default function PlotScrollFrame({
  plotRef,
  xBounds,
  yBounds,
  xLabel,
  yLabel,
  onCommit,
  onError,
  children,
}: {
  plotRef: RefObject<HTMLDivElement | null>;
  xBounds: Range | null;
  yBounds: Range | null;
  xLabel: string;
  yLabel: string;
  onCommit: (ranges: Axes) => void;
  onError: (message: string) => void;
  children: ReactNode;
}) {
  const contentId = useId();
  const [axes, setAxes] = useState<Axes | null>(null);
  const pending = useRef<{ axis: "x" | "y"; range: Range } | null>(null);
  const worker = useRef<Promise<void> | null>(null);
  const live = useRef(true);
  const callbacks = useRef({ onCommit, onError });
  callbacks.current = { onCommit, onError };
  const read = (): Axes | null => {
    const layout = (plotRef.current as any)?._fullLayout;
    const x = layout?.xaxis?.range,
      y = layout?.yaxis?.range;
    return x?.every(Number.isFinite) && y?.every(Number.isFinite)
      ? { x: [...x] as Range, y: [...y] as Range }
      : null;
  };
  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let el: any;
    const sync = () => {
      const next = read();
      if (live.current && next)
        setAxes((previous) =>
          previous &&
          [...previous.x, ...previous.y].every(
            (v, i) => v === [...next.x, ...next.y][i],
          )
            ? previous
            : next,
        );
    };
    const connect = () => {
      el = plotRef.current as any;
      if (!el?.on) {
        timer = setTimeout(connect, 100);
        return;
      }
      el.on("plotly_afterplot", sync);
      sync();
    };
    connect();
    return () => {
      live.current = false;
      pending.current = null;
      clearTimeout(timer);
      el?.removeListener?.("plotly_afterplot", sync);
    };
  }, [plotRef]);

  const preview = (axis: "x" | "y", range: Range) => {
    pending.current = { axis, range };
    if (worker.current) return worker.current;
    worker.current = (async () => {
      while (pending.current && live.current) {
        const next = pending.current;
        pending.current = null;
        const el = plotRef.current;
        if (!el) break;
        try {
          await updatePlotLayout(el, {
            [`${next.axis}axis.range`]: next.range,
          });
        } catch (e) {
          callbacks.current.onError(String(e));
        }
      }
    })().finally(() => {
      worker.current = null;
    });
    return worker.current;
  };
  const commit = async () => {
    await worker.current;
    const current = read();
    if (live.current && current) callbacks.current.onCommit(current);
  };
  return (
    <div className="plot-scroll-frame">
      <div id={contentId} className="plot-scroll-content">
        {children}
      </div>
      <ScrollBar
        axis="y"
        controls={contentId}
        bounds={yBounds}
        range={axes?.y ?? yBounds}
        label={yLabel}
        reverse={!!axes && axes.y[0] < axes.y[1]}
        onPreview={(range) => preview("y", range)}
        onCommit={commit}
      />
      <ScrollBar
        axis="x"
        controls={contentId}
        bounds={xBounds}
        range={axes?.x ?? xBounds}
        label={xLabel}
        reverse={!!axes && axes.x[0] > axes.x[1]}
        onPreview={(range) => preview("x", range)}
        onCommit={commit}
      />
      <div className="plot-scroll-corner" aria-hidden="true" />
    </div>
  );
}

function ScrollBar({
  axis,
  controls,
  bounds,
  range,
  label,
  reverse,
  onPreview,
  onCommit,
}: {
  axis: "x" | "y";
  controls: string;
  bounds: Range | null;
  range: Range | null;
  label: string;
  reverse: boolean;
  onPreview: (range: Range) => Promise<void>;
  onCommit: () => Promise<void>;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [length, setLength] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{
    pointer: number;
    start: number;
    fraction: number;
    range: Range;
    bounds: Range;
    travel: number;
    reverse: boolean;
  } | null>(null);
  const vertical = axis === "y";
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setLength(vertical ? el.clientHeight : el.clientWidth),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [vertical]);
  const metrics =
    bounds && range ? scrollMetrics(bounds, range, length, reverse) : null;
  const enabled = !!metrics?.enabled && metrics.travel > 0;
  const format = (value: number) => Number(value.toFixed(1)).toLocaleString();
  const text = range
    ? `${label} ${ordered(range).map(format).join("–")}`
    : `${label} 暂无数据`;
  const move = (fraction: number) => {
    if (!bounds || !range || !enabled) return;
    void onPreview(scrollWindow(bounds, range, fraction, reverse));
  };
  return (
    <div
      ref={track}
      className={`plot-scrollbar ${vertical ? "is-vertical" : "is-horizontal"}${dragging ? " is-dragging" : ""}`}
      role="scrollbar"
      aria-controls={controls}
      aria-label={`${label}${vertical ? "纵向" : "横向"}滚动条`}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-disabled={!enabled}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((metrics?.fraction ?? 0) * 100)}
      aria-valuetext={text}
      tabIndex={enabled ? 0 : -1}
      title={enabled ? text : `${text}（已显示完整范围）`}
      onPointerDown={(e) => {
        if (!enabled || !metrics || !bounds || !range || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
        const box = e.currentTarget.getBoundingClientRect();
        const at = vertical ? e.clientY - box.top : e.clientX - box.left;
        if (at < metrics.position || at > metrics.position + metrics.size) {
          move(
            metrics.fraction +
              ((at < metrics.position ? -1 : 1) * metrics.span * 0.9) /
                (metrics.total - metrics.span),
          );
          void onCommit();
          return;
        }
        gesture.current = {
          pointer: e.pointerId,
          start: vertical ? e.clientY : e.clientX,
          fraction: metrics.fraction,
          range: [...range],
          bounds: [...bounds],
          travel: metrics.travel,
          reverse,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!g || e.pointerId !== g.pointer) return;
        const delta = (vertical ? e.clientY : e.clientX) - g.start;
        void onPreview(
          scrollWindow(
            g.bounds,
            g.range,
            g.fraction + delta / g.travel,
            g.reverse,
          ),
        );
      }}
      onPointerUp={(e) => {
        if (gesture.current?.pointer !== e.pointerId) return;
        gesture.current = null;
        setDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
        void onCommit();
      }}
      onLostPointerCapture={() => {
        if (gesture.current) {
          gesture.current = null;
          setDragging(false);
          void onCommit();
        }
      }}
      onKeyDown={(e) => {
        if (!enabled || !metrics) return;
        const steps: Record<string, number> = vertical
          ? { ArrowUp: -0.05, ArrowDown: 0.05 }
          : { ArrowLeft: -0.05, ArrowRight: 0.05 };
        steps.PageUp = -0.9;
        steps.PageDown = 0.9;
        if (!(e.key in steps) && e.key !== "Home" && e.key !== "End") return;
        e.preventDefault();
        move(
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? 1
              : metrics.fraction +
                (steps[e.key] * metrics.span) / (metrics.total - metrics.span),
        );
        void onCommit();
      }}
    >
      <div
        className="plot-scroll-thumb"
        style={{
          [vertical ? "height" : "width"]: `${metrics?.size ?? length}px`,
          transform: `${vertical ? "translateY" : "translateX"}(${metrics?.position ?? 0}px)`,
        }}
      />
      {dragging && <span className="plot-scroll-hint">{text}</span>}
    </div>
  );
}
