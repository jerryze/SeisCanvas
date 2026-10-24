import { X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import type { HS } from "../types";
import { modelGroups } from "../horizonOrganization";
import LayerMappingEditor from "./LayerMappingEditor";

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
  model_group: string;
  horizon_keys: string[];
};

type ColumnKey = "inline_column" | "xline_column" | "time_column";

type Props = {
  state: HorizonImportState;
  busy: string;
  onClose: () => void;
  onColumn: (key: ColumnKey, value: number) => void;
  onImport: () => void;
  horizons: HS[];
  onOrganization: (
    patch: Pick<Partial<HorizonImportState>, "model_group" | "horizon_keys">,
  ) => void;
};

/** Import separates data/model setup from optional geological correspondence. */
export default function HorizonImportModal({
  state,
  busy,
  onClose,
  onColumn,
  onImport,
  horizons,
  onOrganization,
}: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const groupList = useId();
  const [step, setStep] = useState(1);
  const [previewPending, setPreviewPending] = useState(false);
  const groups = modelGroups(horizons).filter((g) => g.name);
  const validColumns =
    new Set([state.inline_column, state.xline_column, state.time_column])
      .size === 3;
  const mapped = state.horizon_keys.filter((key) => key.trim()).length;
  useModalFocus(dialog, true, onClose, !busy);
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal horizon-import-modal organization-shell"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="导入层位"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>导入层位</h2>
            <p className="organization-help">
              共 {state.filenames.length} 个文件 ·{" "}
              {step === 1
                ? "先确认所属模型和数据列"
                : `导入到 ${state.model_group.trim() || "未分组"}`}
            </p>
          </div>
          <button
            className="icon"
            aria-label="关闭层位导入"
            disabled={!!busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="import-steps" aria-label="导入步骤">
          <span aria-current={step === 1 ? "step" : undefined}>
            1 · 模型与数据
          </span>
          <span aria-current={step === 2 ? "step" : undefined}>
            2 · 层位对应
          </span>
        </div>
        <div className="organization-editor">
          {step === 1 ? (
            <>
              <label className="import-model-field">
                这些文件属于哪个模型？
                <input
                  aria-label="导入所属模型"
                  list={groupList}
                  maxLength={80}
                  value={state.model_group}
                  disabled={!!busy}
                  placeholder="例如 Base、Ours；也可留空稍后分组"
                  onChange={(e) =>
                    onOrganization({ model_group: e.target.value })
                  }
                />
              </label>
              <datalist id={groupList}>
                {groups.map((g) => (
                  <option key={g.name} value={g.name} />
                ))}
              </datalist>
              <details className="import-files">
                <summary>查看 {state.filenames.length} 个文件</summary>
                {state.filenames.map((name, i) => (
                  <div key={i}>{name}</div>
                ))}
              </details>
              <div className="organization-section-heading">
                <h3>确认数据列</h3>
                <span>应用于本批全部文件</span>
              </div>
              <div className="column-selects">
                {(
                  [
                    ["inline_column", "Inline"],
                    ["xline_column", "Xline"],
                    ["time_column", "Time"],
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
              {!validColumns && (
                <p className="mapping-warning" role="alert">
                  Inline、Xline 和 Time 需要选择不同的数据列。
                </p>
              )}
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
                {state.rows.map((row, index) => (
                  <div
                    className="column-preview-row"
                    key={index}
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
            </>
          ) : (
            <LayerMappingEditor
              model={state.model_group}
              names={state.filenames}
              keys={state.horizon_keys}
              horizons={horizons}
              onPreviewChange={setPreviewPending}
              disabled={!!busy}
              onChange={(horizon_keys) => onOrganization({ horizon_keys })}
            />
          )}
        </div>
        <div className="organization-footer">
          <span>
            {previewPending
              ? "请先应用或放弃对应预览"
              : step === 1
                ? "下一步设置文件与层位的对应关系"
                : `已对应 ${mapped} / ${state.filenames.length} 个，未对应的可稍后设置`}
          </span>
          <button
            className="secondary"
            disabled={!!busy}
            onClick={step === 1 ? onClose : () => setStep(1)}
          >
            {step === 1 ? "取消" : "上一步"}
          </button>
          <button
            className="primary"
            disabled={!!busy || !validColumns || previewPending}
            onClick={step === 1 ? () => setStep(2) : onImport}
          >
            {busy ||
              (step === 1
                ? "下一步：层位对应"
                : `导入 ${state.filenames.length} 个文件`)}
          </button>
        </div>
      </div>
    </div>
  );
}
