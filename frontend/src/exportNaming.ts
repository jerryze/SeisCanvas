/** Only identity fields affect names; styling and live camera updates do not. */
export function exportNameRequest(request: Record<string, any>, format: string, filename: string | null) {
  const state = request.state || {};
  const common = { kind: request.kind, filename, settings: { format } };
  if (request.kind === "2d") return {
    ...common, state: { view_type: state.view_type, section_number: state.section_number },
  };
  if (request.kind === "3d") return {
    ...common, format,
    state: {
      slices: Object.fromEntries(["inline", "crossline", "time"].map(kind => [kind,
        (state.slices?.[kind] || []).map(({ id, position, visible }: any) => ({ id, position, visible })),
      ])),
      horizons: (state.horizons || []).map(({ id, name, visible, display_mode }: any) => ({ id, name, visible, display_mode })),
    },
  };
  if (request.kind === "profile") return {
    ...common, state: { horizon: state.horizon }, a: request.a, b: request.b,
  };
  return {
    ...common, state: {
      horizon: state.horizon, color_by: state.color_by,
      difference_reference: state.difference_reference, difference_comparison: state.difference_comparison,
      difference_type: state.difference_type,
    },
  };
}
