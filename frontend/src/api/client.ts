/** Thin fetch wrapper for the backend API: shared prefix and JSON error detail. */

export async function apiError(response: Response, fallback?: string): Promise<Error> {
  const body = await response.json().catch(() => ({ detail: response.statusText }));
  const detail = (body as { detail?: unknown })?.detail;
  if (fallback && typeof detail !== "string") return new Error(fallback);
  return new Error(
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

export async function api(path: string, init?: RequestInit, errorFallback?: string) {
  const r = await fetch("/api" + path, init);
  if (!r.ok) throw await apiError(r, errorFallback);
  return r;
}

export const json = (value: unknown) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(value),
});
