import type { HorizonMapState } from "../workspace";
import type { HS, SS } from "../types";

/** The A–B raster depends on geometry and sampling, not map color settings. */
export function profileRequestKey(
  state: Pick<HorizonMapState, "horizon">,
  horizonKey: string,
  a: [number, number] | null,
  b: [number, number] | null,
  seismic: Pick<SS, "adaptive_resolution" | "interpolation">,
) {
  return JSON.stringify({
    horizon: state.horizon, horizonKey, a, b,
    adaptive_resolution: seismic.adaptive_resolution,
    interpolation: seismic.interpolation,
  });
}

export function mapPresentation(state: HorizonMapState, horizons: Pick<HS, "id" | "name">[]) {
  const name = (id: string | null) => horizons.find(h => h.id === id)?.name;
  if (state.color_by === "difference") {
    const formula = `${name(state.difference_comparison) || "请选择对比层位"} − ${name(state.difference_reference) || "请选择参考层位"}`;
    return {
      title: `层位差值 · ${state.difference_type === "absolute" ? `|${formula}|` : formula}`,
      scalar: state.difference_type === "absolute" ? "|ΔTWT|" : "ΔTWT",
      unit: "ms",
    };
  }
  return {
    title: `${state.color_by === "amplitude" ? "沿层振幅" : "层位时间"} · ${name(state.horizon) || "请导入层位"}`,
    scalar: state.color_by === "amplitude" ? "振幅" : "TWT",
    unit: state.color_by === "amplitude" ? "" : "ms",
  };
}

export function profileEndpointError(a: [number, number] | null, b: [number, number] | null) {
  if (!a || !b) return "";
  if (![...a, ...b].every(Number.isFinite)) return "A、B 坐标必须是有效数字。";
  return a[0] === b[0] && a[1] === b[1] ? "A、B 不能重合，请重新拾取或修改坐标。" : "";
}

export function mapSelectionError(state: HorizonMapState, horizons: Pick<HS, "id">[]) {
  const loaded = (id: string | null) => horizons.some(h => h.id === id);
  if (!loaded(state.horizon)) return "请先导入或选择已加载的层位。";
  if (state.color_by !== "difference") return "";
  if (horizons.length < 2) return "差值计算需要两个不同层位，请添加层位或切换颜色变量。";
  if (!loaded(state.difference_reference) || !loaded(state.difference_comparison)) return "请选择已加载的参考层位和对比层位，以继续计算差值。";
  return state.difference_reference === state.difference_comparison ? "参考层位和对比层位不能相同，请选择两个不同层位。" : "";
}
