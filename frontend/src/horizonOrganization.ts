import type { HS } from "./types";

export const modelOf = (h: Pick<HS, "model_group">) =>
  (h.model_group || "").trim();
export const layerOf = (h: Pick<HS, "horizon_key">) =>
  (h.horizon_key || "").trim();
export const naturalOrder = (a: string, b: string) =>
  a.localeCompare(b, "zh-CN", { numeric: true });

export function modelGroups(horizons: HS[]) {
  const groups = new Map<string, HS[]>();
  for (const h of horizons) {
    const name = modelOf(h);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(h);
  }
  return [...groups].map(([name, members]) => ({ name, members }));
}

export function layerColors(horizons: HS[]) {
  const colors = new Map<string, string>();
  for (const h of horizons)
    if (layerOf(h) && !colors.has(layerOf(h))) colors.set(layerOf(h), h.color);
  return colors;
}

/** The selected member's new colour is authoritative for its entire layer. */
export function patchHorizon(
  horizons: HS[],
  id: string,
  patch: Partial<HS>,
): HS[] {
  const target = horizons.find((h) => h.id === id);
  if (!target) return horizons;
  const key = layerOf({ ...target, ...patch });
  const linkedColor =
    patch.color ?? (key ? layerColors(horizons).get(key) : undefined);
  return horizons.map((h) => {
    const next = h.id === id ? { ...h, ...patch } : h;
    return key && layerOf(next) === key && linkedColor
      ? { ...next, color: linkedColor }
      : next;
  });
}

/** Resolve a batch against existing identities before choosing any new colours. */
export function organizeHorizons(
  horizons: HS[],
  assignments: Map<string, { model_group: string; horizon_key: string }>,
): HS[] {
  const colors = layerColors(horizons);
  return horizons.map((h) => {
    const assignment = assignments.get(h.id);
    const next = assignment
      ? {
          ...h,
          model_group: assignment.model_group.trim(),
          horizon_key: assignment.horizon_key.trim(),
        }
      : h;
    const key = layerOf(next);
    if (key && !colors.has(key)) colors.set(key, next.color);
    return key ? { ...next, color: colors.get(key)! } : next;
  });
}

export function inheritLayerColors(existing: HS[], added: HS[]): HS[] {
  const colors = layerColors(existing);
  return added.map((h) => {
    const key = layerOf(h);
    if (key && !colors.has(key)) colors.set(key, h.color);
    return key ? { ...h, color: colors.get(key)! } : h;
  });
}

const stem = (name: string) => name.replace(/\.(txt|dat)$/i, "");
/** Only explicit model affixes are removed; no geological identity is guessed. */
export function layerFromName(name: string, model: string): string {
  let result = stem(name).trim();
  const escaped = model.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped)
    result = result.replace(
      new RegExp(`^${escaped}[_\\- .]+|[_\\- .]+${escaped}$`, "i"),
      "",
    );
  return result.slice(0, 80);
}

export function suggestModel(names: string[]): string {
  const parts = names.map((name) => stem(name).split(/[_\- .]+/));
  if (!parts.length || parts.some((p) => p.length < 2)) return "";
  const first = parts[0][0],
    last = parts[0].at(-1)!;
  if (parts.every((p) => p[0] === first) && !/^\d+$/.test(first))
    return first.slice(0, 80);
  if (parts.every((p) => p.at(-1) === last) && !/^\d+$/.test(last))
    return last.slice(0, 80);
  return "";
}

/** Only an explicit command can apply positional correspondence, never import order. */
export function referenceMapping(names: string[], reference: HS[]): string[] {
  const ordered = [...reference].sort((a, b) => naturalOrder(a.name, b.name));
  if (names.length !== ordered.length)
    throw new Error(
      `所选文件有 ${names.length} 个，参照模型有 ${ordered.length} 个；数量不同，请逐项设置对应关系。`,
    );
  const keys = ordered.map(layerOf);
  if (
    !keys.length ||
    keys.some((key) => !key) ||
    new Set(keys).size !== keys.length
  )
    throw new Error("参照模型需要先设置完整且不重复的层位对应关系。");
  const indices = names
    .map((_, i) => i)
    .sort((a, b) => naturalOrder(names[a], names[b]));
  const result = names.map(() => "");
  indices.forEach((index, position) => {
    result[index] = keys[position];
  });
  return result;
}

/** Include the source filename so users can review positional matches before applying them. */
export function referencePreview(names: string[], reference: HS[]) {
  const keys = referenceMapping(names, reference);
  const sources = new Map(reference.map((h) => [layerOf(h), h.name]));
  return names.map((name, index) => ({
    name,
    key: keys[index],
    reference: sources.get(keys[index])!,
  }));
}
