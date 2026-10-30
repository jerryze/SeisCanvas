import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../api/client";
import type { Meta, Section, SectionOverview, VS } from "../types";
import { samplingViewport, sectionContentKey, sectionResponseError, type SectionViewport } from "../components/SeismicViewer2D/sectionDisplay";
import { SectionViewportCache, sectionWindowCovers, sectionWindowIsFinal, type CachedSectionWindow, type SectionWindow } from "./sectionViewportCache";

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
  const loadedSection = useRef<CachedSectionWindow | null>(null);
  const cache = useRef(new SectionViewportCache());
  const content = useRef<{ meta: Meta | null; key: string; sourceKey: string; overview?: SectionOverview } | null>(null);
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
    cache.current.clear();
    content.current = null;
    setSection(null);
    setLoading(false);
  }, []);

  const sampling = samplingViewport(view.seismic, viewport);
  const contentKey = sectionContentKey(view, revision);
  const sourceKey = JSON.stringify([view.view_type, view.section_number]);
  useEffect(() => {
    if (content.current?.meta !== meta || content.current.key !== contentKey) {
      const sourceChanged = content.current?.meta !== meta || content.current.sourceKey !== sourceKey;
      content.current = { meta, key: contentKey, sourceKey };
      cache.current.clear();
      loadedSection.current = null;
      // Never draw the old source beneath a new section's coordinates/title.
      // Same-source parameter changes may retain its raster during refinement.
      setSection(current => sourceChanged ? null : current?.overview ? { ...current, overview: undefined } : current);
    }
    if (!meta || view.view_mode !== "2d") {
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    const abort = new AbortController();
    let active = true;
    const box = plotWrap.current;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const positions = view.view_type === "inline" ? meta.crosslines : meta.inlines;
    const fullX = [positions[0] - (positions.length > 1 ? (positions[1] - positions[0]) / 2 : .5),
      positions.at(-1)! + (positions.length > 1 ? (positions.at(-1)! - positions.at(-2)!) / 2 : .5)];
    const requestGeometry = (requestView: VS) => {
      const measured = sectionViewportRef.current;
      const dimensions = {
        target_width: measured ? Math.round(measured.width * ratio) : box ? Math.round(box.clientWidth * ratio) : null,
        target_height: measured ? Math.round(measured.height * ratio) : box ? Math.round(box.clientHeight * ratio) : null,
        trace_viewport_width: measured?.width ?? null,
        trace_viewport_height: measured?.height ?? null,
      };
      const window: SectionWindow = {
        key: JSON.stringify([requestView.x_range, requestView.time_range, dimensions]),
        x: requestView.x_range ?? fullX, time: requestView.time_range ?? meta.time_range,
        width: dimensions.target_width ?? 1, height: dimensions.target_height ?? 1,
        interpolate: requestView.seismic.background_interpolation,
        overlays: requestView.seismic.wiggle || requestView.seismic.variable_area,
      };
      return { dimensions, window };
    };
    const requested = requestGeometry(view).window;
    const loaded = loadedSection.current;
    const cached = cache.current.find(requested) ??
      (loaded && sectionWindowCovers(loaded, requested) ? loaded : null);
    if (cached) {
      loadedSection.current = cached;
      setSection(cached.data);
      if (sectionWindowIsFinal(cached, requested)) {
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const requestView = latest.current.view;
        const { dimensions, window: requestedWindow } = requestGeometry(requestView);
        const response = await api("/section", {
          ...json({
            ...requestView,
            quality: "interactive",
            ...dimensions,
            include_overview: !content.current?.overview,
          }),
          signal: abort.signal,
        });
        const next: Section = await response.json();
        if (!active || id !== requestId.current) return;
        const compatibilityError = sectionResponseError(next, requestView.seismic);
        if (compatibilityError) throw new Error(compatibilityError);
        if (requestView.horizon_sg && (!next.horizon_display || next.horizon_display.algorithm !== "sg"))
          throw new Error("层位平滑不可用，请重启 SeisCanvas。");
        const overview = next.overview ?? content.current?.overview;
        if (content.current) content.current.overview = overview;
        const accepted = overview && !next.overview ? { ...next, overview } : next;
        setSection(accepted);
        loadedSection.current = cache.current.remember(requestedWindow.key, accepted);
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
  }, [meta, view.view_mode, contentKey, sourceKey, view.x_range, view.time_range, sampling.width, sampling.height]);

  // Hide mismatched source data in the changing render itself, before the
  // passive effect clears state and starts the next request.
  const visibleSection = content.current?.meta === meta && content.current.sourceKey === sourceKey ? section : null;
  return { section: visibleSection, loading, plotWrap, sectionViewportRef, measuredSectionViewport, resetSection };
}
