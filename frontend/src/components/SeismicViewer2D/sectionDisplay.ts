import { Section, SS } from "../../types";

export type SectionViewport = { width: number; height: number };

/** Measure the usable CSS plot, after Plotly applies margins and aspect lock. */
export function measureSectionViewport(layout: any): SectionViewport | null {
  const width = Math.round(layout?.xaxis?._length);
  const height = Math.round(layout?.yaxis?._length);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height } : null;
}

/** Native cells/raw trace paths only need width updates for trace density. */
export function samplingViewport(settings: SS, viewport: SectionViewport | null) {
  const overlay = settings.wiggle || settings.variable_area;
  return {
    width: settings.background_interpolation || overlay ? viewport?.width ?? null : null,
    height: settings.background_interpolation || (overlay && settings.wiggle_interpolation)
      ? viewport?.height ?? null : null,
  };
}

/** A stale running backend must not silently ignore selected 2D capabilities. */
export function sectionResponseError(section: Section, settings: SS): string | null {
  const overlay = settings.wiggle || settings.variable_area;
  const incompatible =
    (settings.background_interpolation &&
      (section.background_interpolation !== true || section.interpolation !== "sinc8")) ||
    (section.background_interpolation !== undefined &&
      section.background_interpolation !== settings.background_interpolation) ||
    (overlay && !section.trace_overlay) ||
    (overlay && settings.wiggle_interpolation && section.wiggle_interpolation !== true) ||
    (overlay && section.wiggle_interpolation !== undefined &&
      section.wiggle_interpolation !== settings.wiggle_interpolation);
  return incompatible ? "二维显示后端版本不匹配，请重启 SeisCanvas 后端以启用插值和波形功能。" : null;
}
