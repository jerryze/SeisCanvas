import { FolderOpen, Layers, Upload } from "lucide-react";
import { Meta } from "../../types";
import { Group, Num } from "../Controls";

export type ImportProgress = { percent: number; stage: string; status: string };

type Props = {
  progress: ImportProgress | null;
  busy: string;
  onOpenSegy: () => void;
  onLoadExample: () => void;
  geometryMode: string;
  onGeometryMode: (mode: string) => void;
  bytes: { il: number; xl: number };
  onBytes: (update: (b: { il: number; xl: number }) => { il: number; xl: number }) => void;
  meta: Meta | null;
};

/** Sidebar "数据" group: SEG-Y import, example data, byte positions, metadata. */
export default function DataPanel({
  progress,
  busy,
  onOpenSegy,
  onLoadExample,
  geometryMode,
  onGeometryMode,
  bytes,
  onBytes,
  meta,
}: Props) {
  return (
    <Group icon={<FolderOpen size={16} />} title="数据">
      {progress && (
        <div className="import-progress" role="status" aria-live="polite">
          <div>
            <span>{progress.stage}</span>
            <b>{progress.status === "waiting" ? "" : `${progress.percent}%`}</b>
          </div>
          <progress
            aria-label="SEG-Y 导入进度"
            max={100}
            value={progress.status === "waiting" ? undefined : progress.percent}
          />
        </div>
      )}
      <button className="primary full" disabled={!!busy} onClick={onOpenSegy}>
        <Upload size={14} />
        导入 SEG-Y
      </button>

      <button className="secondary full" disabled={!!busy} onClick={onLoadExample}>
        <Layers size={14} />
        加载 F3 示例
      </button>

      <label className="field">
        几何模式
        <select
          value={geometryMode}
          disabled={!!busy}
          onChange={(e) => onGeometryMode(e.target.value)}
        >
          <option value="auto">自动</option>
          <option value="regular">规则网格（快速）</option>
        </select>
      </label>
      <div className="field-row">
        <label>
          Inline 字节
          <Num
            value={bytes.il}
            onChange={(il) => onBytes((b) => ({ ...b, il }))}
            min={1}
            max={237}
          />
        </label>

        <label>
          Crossline 字节
          <Num
            value={bytes.xl}
            onChange={(xl) => onBytes((b) => ({ ...b, xl }))}
            min={1}
            max={237}
          />
        </label>
      </div>

      {meta && (
        <div className="metadata">
          <div className="filename" title={meta.filename}>
            <span className="status-dot" />
            {meta.filename}
          </div>

          <div>
            <span>Inline</span>
            <b>
              {meta.inlines[0]}–{meta.inlines.at(-1)}
              <em> ({meta.inlines.length})</em>
            </b>
          </div>

          <div>
            <span>Crossline</span>
            <b>
              {meta.crosslines[0]}–{meta.crosslines.at(-1)}
              <em> ({meta.crosslines.length})</em>
            </b>
          </div>

          <div>
            <span>TWT</span>
            <b>{meta.time_range.join("–")} ms</b>
          </div>

          <div>
            <span>采样</span>
            <b>
              {meta.samples} × {meta.sample_interval} ms
            </b>
          </div>
        </div>
      )}
    </Group>
  );
}
