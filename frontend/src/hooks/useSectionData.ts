import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../api/client";
import type { Meta, Section, VS } from "../types";
import { coversViewport } from "../components/loadedRaster";
import { samplingViewport, sectionContentKey, sectionResponseError, type SectionViewport } from "../components/SeismicViewer2D/sectionDisplay";

/** Viewport-matched 2D data, retaining the last raster during a refresh.
 * resetSection invalidates old work; meta/view/revision changes reload it.
 * sectionViewportRef contains CSS sizes, independent of raster device pixels.
 */
export function useSectionData(meta: Meta | null, view: VS, revision: number, onError: (message: string) => void) {
  const [section, setSection] = useState<Section | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewport, setViewport] = useState<SectionViewport | null>(null);
  const plotWrap = useRef<HTMLDivElement>(null);
  const sectionViewportRef = useRef<SectionViewport | null>(null);
  const loadedSection = useRef<{ meta: Meta; key: string; data: Section } | null>(null);
  const requestId = useRef(0);
  const cancelRequest = useRef<(() => void) | null>(null);
  const latest = useRef({ view, onError });
  latest.current = { view, onError };

  const measuredSectionViewport = useCallback((next: SectionViewport) => {
    sectionViewportRef.current = next;
    setViewport(current => current?.width === next.width && current.height === next.height ? current : next);
  }, []);

  const resetSection = useCallback(() => {
    requestId.current++;
    cancelRequest.current?.();
    cancelRequest.current = null;
    loadedSection.current = null;
    setSection(null);
    setLoading(false);
  }, []);

  const sampling = samplingViewport(view.seismic, viewport);
  const contentKey = sectionContentKey(view, revision);
  useEffect(() => {
    if (!meta || view.view_mode !== "2d") {
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    const abort = new AbortController();
    let active = true;
    const box = plotWrap.current;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = sectionViewportRef.current?.width ?? box?.clientWidth ?? 1;
    const height = sectionViewportRef.current?.height ?? box?.clientHeight ?? 1;
    const positions = view.view_type === "inline" ? meta.crosslines : meta.inlines;
    const fullX = [positions[0] - (positions.length > 1 ? (positions[1] - positions[0]) / 2 : .5),
      positions.at(-1)! + (positions.length > 1 ? (positions.at(-1)! - positions.at(-2)!) / 2 : .5)];
    const loaded = loadedSection.current;
    if (loaded?.meta === meta && loaded.key === contentKey &&
      coversViewport(loaded.data, view.x_range ?? fullX, view.time_range ?? meta.time_range,
        Math.round(width * ratio), Math.round(height * ratio), view.seismic.background_interpolation,
        view.seismic.wiggle || view.seismic.variable_area)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const requestView = latest.current.view;
        const measured = sectionViewportRef.current;
        const response = await api("/section", {
          ...json({
            ...requestView,
            quality: "interactive",
            target_width: measured ? Math.round(measured.width * ratio) : box ? Math.round(box.clientWidth * ratio) : null,
            target_height: measured ? Math.round(measured.height * ratio) : box ? Math.round(box.clientHeight * ratio) : null,
            trace_viewport_width: measured?.width ?? null,
            trace_viewport_height: measured?.height ?? null,
          }),
          signal: abort.signal,
        });
        const next: Section = await response.json();
        if (!active || id !== requestId.current) return;
        const compatibilityError = sectionResponseError(next, requestView.seismic);
        if (compatibilityError) throw new Error(compatibilityError);
        if (requestView.horizon_sg && (!next.horizon_display || next.horizon_display.algorithm !== "sg"))
          throw new Error("层位平滑不可用，请重启 SeisCanvas。");
        setSection(next);
        loadedSection.current = { meta, key: contentKey, data: next };
        latest.current.onError("");
      } catch (error) {
        if (active && id === requestId.current && (error as Error).name !== "AbortError")
          latest.current.onError((error as Error).message);
      } finally {
        if (active && id === requestId.current) setLoading(false);
      }
    }, 200);
    const cancel = () => {
      active = false;
      clearTimeout(timer);
      abort.abort();
    };
    cancelRequest.current = cancel;
    return () => {
      cancel();
      if (cancelRequest.current === cancel) cancelRequest.current = null;
    };
  }, [meta, view.view_mode, contentKey, view.x_range, view.time_range, sampling.width, sampling.height]);

  return { section, loading, plotWrap, sectionViewportRef, measuredSectionViewport, resetSection };
}
