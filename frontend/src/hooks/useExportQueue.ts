import { useCallback, useEffect, useState } from "react";
import { ExportItem } from "../types";
import { api, json } from "../api/client";

type Task = (label: string, fn: () => Promise<void>) => Promise<void>;

/** Client state for the backend export session: list, rename, delete, ZIP. */
export function useExportQueue(opts: {
  task: Task;
  notify: (message: string) => void;
  onError: (message: string) => void;
}) {
  const { task, notify, onError } = opts;
  const [items, setItems] = useState<ExportItem[]>([]);
  const [sessionId, setSessionId] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await api("/export/queue");
      const data = await r.json();
      setItems(data.items || []);
      setSessionId(data.session || "");
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Render-once contract: send a kind + state/settings payload to the queue. */
  const addItem = useCallback(
    async (body: Record<string, unknown>) => {
      const r = await api("/export/queue", json(body));
      const item: ExportItem = await r.json();
      await refresh();
      notify(`已保存图件\n${item.filename}`);
      return item;
    },
    [refresh, notify],
  );

  const rename = useCallback(
    (item: ExportItem, filename: string) =>
      task("正在重命名图件…", async () => {
        await api(`/export/queue/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename }),
        });
        await refresh();
      }),
    [task, refresh],
  );

  const remove = useCallback(
    (item: ExportItem) =>
      task("删除暂存图片…", async () => {
        await api(`/export/queue/${item.id}`, { method: "DELETE" });
        await refresh();
      }),
    [task, refresh],
  );

  const clear = useCallback(
    () =>
      task("清空导出队列…", async () => {
        await api("/export/queue", { method: "DELETE" });
        await refresh();
        notify("队列已清空");
      }),
    [task, refresh, notify],
  );

  const exportItems = useCallback(
    (itemIds?: string[]) =>
      task("正在打包 ZIP…", async () => {
        const r = await api("/export/archive", itemIds ? json({ item_ids: itemIds }) : { method: "POST" });
        const header = r.headers.get("X-Export-Filename");
        let name = "SeisCanvas_Export.zip";
        if (header) {
          try {
            name = decodeURIComponent(header);
          } catch {
            name = header;
          }
        }
        const url = URL.createObjectURL(await r.blob());
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notify(`ZIP 已导出\n${name}`);
      }),
    [task, notify],
  );

  return { items, sessionId, refresh, addItem, rename, remove, clear, exportItems };
}
