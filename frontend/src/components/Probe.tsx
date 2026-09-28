import { useCallback, useRef, useState } from "react";
import { api, json } from "../api/client";

/** Where the cursor is, in original seismic coordinates. */
export type ProbeRequest = {
  kind: "inline" | "crossline" | "time";
  position: number;
  inline?: number | null;
  crossline?: number | null;
  time?: number | null;
};

export type ProbeReading = {
  kind: "inline" | "crossline" | "time";
  position: number;
  inline: number;
  crossline: number;
  time: number;
  amplitude: number | null;
  source: string;
};

const key = (request: ProbeRequest) =>
  [
    request.kind,
    request.position,
    request.inline ?? "",
    request.crossline ?? "",
    request.time ?? "",
  ].join("|");

/**
 * Hover readout backed by the original SEG-Y samples.
 *
 * Display rasters may be interpolated or area averaged; the readout must not
 * be, so every new position asks the backend for the real sample and caches it.
 */
export function useOriginalProbe(delay = 60) {
  const [reading, setReading] = useState<ProbeReading | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cache = useRef(new Map<string, ProbeReading>());
  const latest = useRef(0);

  const probe = useCallback(
    (request: ProbeRequest) => {
      const id = key(request);
      const hit = cache.current.get(id);
      if (hit) {
        setReading(hit);
        return;
      }
      latest.current++;
      const token = latest.current;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        try {
          const response = await api("/sample", json(request));
          const value: ProbeReading = await response.json();
          if (cache.current.size > 4096) cache.current.clear();
          cache.current.set(id, value);
          if (token === latest.current) setReading(value);
        } catch {
          /* A missing probe must never interrupt browsing. */
        }
      }, delay);
    },
    [delay],
  );

  const reset = useCallback(() => setReading(null), []);
  return { reading, probe, reset };
}

export function ProbeReadout({ reading }: { reading: ProbeReading | null }) {
  if (!reading) {
    return (
      <div className="probe-readout idle">
        <span>悬停读取原始振幅</span>
      </div>
    );
  }
  return (
    <div className="probe-readout" role="status" aria-live="polite">
      <span>
        IL <b>{reading.inline}</b>
      </span>
      <span>
        XL <b>{reading.crossline}</b>
      </span>
      <span>
        TWT <b>{reading.time.toFixed(1)}</b> ms
      </span>
      <span className="probe-amplitude">
        振幅 <b>{reading.amplitude === null ? "—" : reading.amplitude.toPrecision(6)}</b>
        <em>原始 SEG-Y</em>
      </span>
    </div>
  );
}
