import { X } from "lucide-react";

/** Pending horizon-column mapping between the file picker preview and import. */
export type HorizonImportState = {
  token: string;
  filename: string;
  filenames: string[];
  columns: { index: number; name: string }[];
  rows: string[][];
  inline_column: number;
  xline_column: number;
  time_column: number;
};

type ColumnKey = "inline_column" | "xline_column" | "time_column";

type Props = {
  state: HorizonImportState;
  busy: string;
  onClose: () => void;
  onColumn: (key: ColumnKey, value: number) => void;
  onImport: () => void;
};

/** Modal for mapping Inline/Xline/TWT columns of a freshly picked horizon file. */
export default function HorizonImportModal({
  state,
  busy,
  onClose,
  onColumn,
  onImport,
}: Props) {
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal horizon-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="选择层位列"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <h2>选择层位列</h2>
          <button className="icon" disabled={!!busy} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="import-file-name">
          已选择 {state.filenames.length} 个文件，以第一个文件 {state.filename}{" "}
          为例设置。
          <p>以下列映射将应用于全部文件，请确保各文件列布局一致。</p>
          <details>
            <summary>查看文件列表</summary>
            {state.filenames.map((name, i) => (
              <div key={i}>{name}</div>
            ))}
          </details>
        </div>

        <div className="column-selects">
          {(
            [
              ["inline_column", "Inline"],
              ["xline_column", "Xline"],
              ["time_column", "Time / TWT"],
            ] as const
          ).map(([key, label]) => (
            <label className="field" key={key}>
              {label}
              <select
                disabled={!!busy}
                value={state[key]}
                onChange={(e) => onColumn(key, Number(e.target.value))}
              >
                {state.columns.map((column) => (
                  <option key={column.index} value={column.index}>
                    {column.index + 1}: {column.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <div className="column-preview" aria-label="层位数据预览">
          <div
            className="column-preview-row column-preview-header"
            style={{
              gridTemplateColumns: `repeat(${state.columns.length}, minmax(100px, 1fr))`,
            }}
          >
            {state.columns.map((column) => (
              <span key={column.index}>
                {column.index + 1}. {column.name}
              </span>
            ))}
          </div>
          {state.rows.map((row, rowIndex) => (
            <div
              className="column-preview-row"
              key={rowIndex}
              style={{
                gridTemplateColumns: `repeat(${state.columns.length}, minmax(100px, 1fr))`,
              }}
            >
              {state.columns.map((column) => (
                <span key={column.index}>{row[column.index] || "—"}</span>
              ))}
            </div>
          ))}
        </div>

        <div className="import-actions">
          <button className="secondary" disabled={!!busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={
              !!busy ||
              new Set([
                state.inline_column,
                state.xline_column,
                state.time_column,
              ]).size !== 3
            }
            onClick={onImport}
          >
            {busy || `确认并导入 ${state.filenames.length} 个文件`}
          </button>
        </div>
      </div>
    </div>
  );
}
