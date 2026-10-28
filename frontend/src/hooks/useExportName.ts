import { useEffect, useRef, useState } from "react";
import { api, json } from "../api/client";
import { exportNameRequest } from "../exportNaming";

/** Server naming is shared with submission; stale previews can never be saved. */
export function useExportName(
  open: boolean,
  request: Record<string, unknown>,
  format: string,
) {
  const [custom, setCustom] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    filename: string;
    error: string;
  } | null>(null);
  const body = JSON.stringify(exportNameRequest(request, format, custom));
  const requestBody = useRef(body);
  requestBody.current = body;
  // Once explicitly named, only the name and format affect the preview.
  // Committing another field on blur must not disable a ready Save button.
  const key = `${refresh}:${custom === null ? body : JSON.stringify([request.kind, custom, format])}`;
  const blank = custom !== null && !custom.trim();
  useEffect(() => {
    if (!open) {
      setCustom(null);
      setResult(null);
      return;
    }
    if (blank) return;
    const controller = new AbortController();
    let current = true;
    const timer = setTimeout(
      async () => {
        try {
          const response = await api("/export/name", {
            ...json(JSON.parse(requestBody.current)),
            signal: controller.signal,
          });
          const value = await response.json();
          if (typeof value.filename !== "string" || !value.filename) throw new Error("无法生成文件名");
          if (current) setResult({ key, filename: value.filename, error: "" });
        } catch (error) {
          if (current && !controller.signal.aborted)
            setResult({ key, filename: "", error: (error as Error).message });
        }
      },
      custom === null ? 0 : 200,
    );
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, key, blank, custom]);
  const fresh = result?.key === key;
  const filename = fresh ? result.filename : "";
  return {
    value: filename ? filename.replace(/\.(png|pdf|svg)$/i, "") : custom ?? "",
    extension: format,
    resolved: filename,
    pending: open && !blank && !fresh,
    error: blank ? "文件名不能为空" : fresh ? result.error : "",
    onChange: setCustom,
    onReset: () => {
      setCustom(null);
      setRefresh((value) => value + 1);
    },
  };
}
