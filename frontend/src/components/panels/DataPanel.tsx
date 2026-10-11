import { FolderOpen, Layers, LoaderCircle, Upload } from "lucide-react";
import { Meta } from "../../types";
import { Group, Num, SubsectionSummary, Select } from "../Controls";

export type ImportProgress = { percent: number; stage: string; status: string };

type Props = {
  datasetName: string;
  progress: ImportProgress | null;
  busy: string;
  onOpenSegy: () => void;
  onLoadExample: () => void;
  geometryMode: string;
  onGeometryMode: (mode: string) => void;
  bytes: { il: number; xl: number };
  onBytes: (
    update: (b: { il: number; xl: number }) => { il: number; xl: number },
  ) => void;
  meta: Meta | null;
};

/** Sidebar "数据" group: SEG-Y import, example data, byte positions, metadata. */
export default function DataPanel({
  datasetName,
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
  const importing = !!progress && progress.status !== "done";
  return (
    <Group
      icon={<FolderOpen size={16} />}
      title="数据"
      hintTitle={meta?.filename}
      hint={
        meta || importing ? (
          <span className="dataset-summary">
            {importing ? (
              <LoaderCircle className="spin" size={14} aria-label="正在导入" />
            ) : (
              <span className="status-dot" role="img" aria-label="已加载" />
            )}
            <span className="dataset-name">
              {meta ? datasetName : "导入中…"}
            </span>
          </span>
        ) : undefined
      }
      defaultOpen={!meta}
    >
      {progress && importing && (
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
      {meta && (
        <dl className="metadata" aria-label="数据范围与采样">
          <dt>Inline</dt>
          <dd
            className="metadata-value"
            title={`${meta.inlines[0]}–${meta.inlines.at(-1)}`}
          >
            {meta.inlines[0]}–{meta.inlines.at(-1)}
          </dd>
          <dd className="metadata-count" title="Inline 数量">
            {meta.inlines.length}
          </dd>
          <dt>Crossline</dt>
          <dd
            className="metadata-value"
            title={`${meta.crosslines[0]}–${meta.crosslines.at(-1)}`}
          >
            {meta.crosslines[0]}–{meta.crosslines.at(-1)}
          </dd>
          <dd className="metadata-count" title="Crossline 数量">
            {meta.crosslines.length}
          </dd>
          <dt>TWT</dt>
          <dd
            className="metadata-value"
            title={`${meta.time_range.join("–")} ms`}
          >
            {meta.time_range.join("–")}
          </dd>
          <dd className="metadata-count">ms</dd>
          <dt>采样</dt>
          <dd
            className="metadata-value"
            title={`采样间隔 ${meta.sample_interval} ms`}
          >
            {meta.sample_interval} ms
          </dd>
          <dd className="metadata-count" title="采样点数">
            {meta.samples} 点
          </dd>
        </dl>
      )}
      <div className="panel-actions">
        <button
          className={`${meta ? "panel-action" : "primary"} full`}
          disabled={!!busy}
          onClick={onOpenSegy}
        >
          <Upload size={14} />
          {meta ? "更换 SEG-Y 数据" : "导入 SEG-Y"}
        </button>

        {!meta && (
          <button
            className="panel-action full"
            disabled={!!busy}
            onClick={onLoadExample}
          >
            <Layers size={14} />
            加载 F3 示例
          </button>
        )}

        <details className="subsettings">
          <SubsectionSummary title="导入设置" tooltip="用于下一次导入" />
          <div className="subsettings-body">
            <label className="field">
              几何模式
              <Select
                value={geometryMode}
                disabled={!!busy}
                onChange={(e) => onGeometryMode(e.target.value)}
              >
                <option value="auto">自动</option>
                <option value="regular">规则网格（快速）</option>
              </Select>
            </label>
            <div className="field-row">
              <label>
                Inline 字节
                <Num
                  value={bytes.il}
                  disabled={!!busy}
                  onChange={(il) => onBytes((b) => ({ ...b, il }))}
                  min={1}
                  max={237}
                />
              </label>

              <label>
                Crossline 字节
                <Num
                  value={bytes.xl}
                  disabled={!!busy}
                  onChange={(xl) => onBytes((b) => ({ ...b, xl }))}
                  min={1}
                  max={237}
                />
              </label>
            </div>
            {meta && (
              <button
                className="panel-action full"
                disabled={!!busy}
                onClick={onLoadExample}
              >
                <Layers size={14} /> 加载 F3 示例
              </button>
            )}
          </div>
        </details>
      </div>
    </Group>
  );
}
