import { useCallback, useEffect, useRef, useState } from "react";
import { api, json } from "../api/client";
import { createProbeController, type ProbeReading, type ProbeRequest } from "./probeController";
export type { ProbeReading, ProbeRequest } from "./probeController";

/**
 * Hover readout backed by the original SEG-Y samples.
 *
 * Display rasters may be interpolated or area averaged; the readout must not
 * be, so every new position asks the backend for the real sample and caches it.
 */
export function useOriginalProbe(delay = 60) {
  const [reading, setReading] = useState<ProbeReading | null>(null);
  const controller = useRef<ReturnType<typeof createProbeController> | null>(null);
  useEffect(() => {
    const current = createProbeController({
      delay,
      onReading: setReading,
      request: async (request, signal) => {
        const response = await api("/sample", { ...json(request), signal });
        return response.json();
      },
    });
    controller.current = current;
    return () => {
      current.dispose();
      if (controller.current === current) controller.current = null;
    };
  }, [delay]);
  const probe = useCallback((request: ProbeRequest) => controller.current?.probe(request), []);
  const reset = useCallback(() => controller.current?.reset(), []);
  return { reading, probe, reset };
}

export function ProbeReadout({ reading }: { reading: ProbeReading | null }) {
  if (!reading) return null;
  return (
    <div className="probe-readout" role="status" aria-live="polite">
      <span>
        IL <b>{reading.inline}</b>
      </span>
      <span>
        XL <b>{reading.crossline}</b>
      </span>
      <span>
        Time <b>{reading.time.toFixed(1)}</b> ms
      </span>
      <span className="probe-amplitude" title="原始 SEG-Y 振幅">
        振幅 <b>{reading.amplitude === null ? "—" : reading.amplitude.toPrecision(6)}</b>
      </span>
    </div>
  );
}
