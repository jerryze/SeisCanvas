import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import type { HS } from "../types";
import { layerColors, modelGroups } from "../horizonOrganization";
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
const columnFields = [
  ["inline_column", "Inline"],
  ["xline_column", "Xline"],
  ["time_column", "Time"],
] as const;
const steps = ["分组与数据", "层位对应", "核对导入"];
type Props = {
  state: HorizonImportState;
  busy: string;
  error?: string;
  onClose: () => void;
  onColumn: (key: ColumnKey, value: number) => void;
  onImport: () => void;
  horizons: HS[];
  onOrganization: (
    patch: Pick<Partial<HorizonImportState>, "model_group" | "horizon_keys">,
  ) => void;
};

/** Review data, correspondence and inherited colours before importing a batch. */
export default function HorizonImportModal({
  state,
  busy,
  error,
  onClose,
  onColumn,
  onImport,
  horizons,
  onOrganization,
}: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const initial = useRef(JSON.stringify(state));
  const groupList = useId();
  const [step, setStep] = useState(0);
  const [previewPending, setPreviewPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const groups = modelGroups(horizons).filter((g) => g.name);
  const model = state.model_group.trim();
  const existing = groups.find((g) => g.name === model);
  const colors = layerColors(horizons);
  const validColumns =
    new Set(columnFields.map(([key]) => state[key])).size === 3 &&
    columnFields.every(([key]) =>
      state.columns.some((c) => c.index === state[key]),
    );
  const mapped = state.filenames.filter((_, i) =>
    state.horizon_keys[i]?.trim(),
  ).length;
  const missing = state.filenames.length - mapped;
  const changed = initial.current !== JSON.stringify(state);
  const close = () => {
    if (busy) return;
    if (changed || previewPending) setClosing(true);
    else onClose();
  };
  useModalFocus(dialog, true, close, !busy);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const go = (next: number) => {
    setClosing(false);
    setStep(next);
  };
  const columnName = (key: ColumnKey) => {
    const column = state.columns.find((c) => c.index === state[key]);
    return column ? `第 ${column.index + 1} 列（${column.name}）` : "未选择";
  };
  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal horizon-import-modal organization-shell"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="导入层位"
        aria-busy={!!busy}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>导入层位</h2>
            <div className="import-overview">
              <span>{state.filenames.length} 个文件</span>
              <span>{model || "未分组"}</span>
              <span>{mapped} 个已对应</span>
            </div>
          </div>
          <button
            className="icon"
            aria-label="关闭层位导入"
            disabled={!!busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <ol className="import-steps" aria-label="导入步骤">
          {steps.map((label, i) => (
            <li key={label} aria-current={step === i ? "step" : undefined}>
              <span className="import-step-number">{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <div className="organization-editor">
          <div className="organization-section-heading">
            <h3 ref={heading} tabIndex={-1}>
              {steps[step]}
            </h3>
            <span>
              {step === 0
                ? "应用于本批全部文件"
                : `${mapped} 个已对应，${missing} 个未对应`}
            </span>
          </div>
          {step === 0 ? (
            <>
              <label className="import-model-field">
                所属分组
                <input
                  aria-label="导入所属分组"
                  list={groupList}
                  maxLength={80}
                  value={state.model_group}
                  disabled={!!busy}
                  placeholder="选择分组或输入新分组名称"
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
              <p className="organization-help">
                {!model
                  ? "留空将放入未分组，导入后可批量整理。"
                  : existing
                    ? `加入已有分组，当前包含 ${existing.members.length} 个文件。`
                    : "导入时创建此分组。"}
              </p>
              <details className="import-files">
                <summary>已选文件（{state.filenames.length}）</summary>
                <ul>
                  {state.filenames.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </details>
              <div className="import-data-heading">
                <h3>数据列</h3>
                <span className="organization-muted">每个字段选择不同的列</span>
              </div>
              <div className="column-selects">
                {columnFields.map(([key, label]) => (
                  <label className="field" key={key}>
                    {label}
                    <select
                      disabled={!!busy}
                      value={state[key]}
                      onChange={(e) => onColumn(key, Number(e.target.value))}
                    >
                      {state.columns.map((c) => (
                        <option key={c.index} value={c.index}>
                          {c.index + 1}: {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {!validColumns && (
                <p className="mapping-warning" role="alert">
                  Inline、Xline 和 Time 需要选择不同的有效数据列。
                </p>
              )}
              <div className="import-preview-label">
                <span>数据预览</span>
                <span title={state.filename}>{state.filename}</span>
              </div>
              <div className="organization-table-wrap import-data-preview">
                <table className="organization-table">
                  <thead>
                    <tr>
                      {state.columns.map((c) => (
                        <th key={c.index}>
                          {c.index + 1}. {c.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {state.rows.map((row, i) => (
                      <tr key={i}>
                        {state.columns.map((c) => (
                          <td key={c.index}>{row[c.index] || "—"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : step === 1 ? (
            <LayerMappingEditor
              model={state.model_group}
              names={state.filenames}
              keys={state.horizon_keys}
              horizons={horizons}
              onPreviewChange={setPreviewPending}
              disabled={!!busy}
              onChange={(horizon_keys) => onOrganization({ horizon_keys })}
            />
          ) : (
            <>
              <dl className="import-summary">
                <div>
                  <dt>所属分组</dt>
                  <dd>
                    {model || "未分组"}
                    <span>
                      {!model
                        ? "导入后可分组"
                        : existing
                          ? "加入已有分组"
                          : "新建分组"}
                    </span>
                  </dd>
                </div>
                {columnFields.map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{columnName(key)}</dd>
                  </div>
                ))}
              </dl>
              <div className="organization-table-wrap">
                <table className="organization-table import-review-table">
                  <thead>
                    <tr>
                      <th>层位文件</th>
                      <th>对应层位</th>
                      <th>颜色</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.filenames.map((name, i) => {
                      const key = state.horizon_keys[i]?.trim() || "";
                      const color = colors.get(key);
                      return (
                        <tr key={i}>
                          <td>{name}</td>
                          <td>
                            {key || (
                              <span className="import-attention">未对应</span>
                            )}
                          </td>
                          <td>
                            <span className="import-color-source">
                              {color && (
                                <span
                                  className="layer-color-dot"
                                  style={{ background: color }}
                                  aria-label={`${key} 颜色 ${color}`}
                                />
                              )}
                              <span>
                                {color
                                  ? "沿用统一颜色"
                                  : key
                                    ? "导入时分配统一颜色"
                                    : "独立颜色"}
                              </span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="organization-help">
                {missing
                  ? `${missing} 个文件尚未对应，可先导入，再到层位管理中设置。`
                  : "同一层位沿用统一颜色，导入后可在层位管理中调整。"}
              </p>
            </>
          )}
          {error && (
            <p className="mapping-warning" role="alert">
              导入未完成：{error}
            </p>
          )}
        </div>
        <div
          className={`organization-footer${closing ? " organization-footer-confirm" : ""}`}
        >
          <span role="status">
            {busy ||
              (closing
                ? "关闭将放弃本次导入设置"
                : previewPending
                  ? "请先应用或取消当前对应预览"
                  : step === 0
                    ? "确认分组和数据列后继续"
                    : step === 1
                      ? "未对应的文件可稍后设置"
                      : "核对清单后导入")}
          </span>
          {closing ? (
            <>
              <button className="secondary" onClick={() => setClosing(false)}>
                继续编辑
              </button>
              <button className="secondary danger" onClick={onClose}>
                放弃导入
              </button>
            </>
          ) : (
            <>
              <button
                className="secondary"
                disabled={!!busy || previewPending}
                onClick={step === 0 ? close : () => go(step - 1)}
              >
                {step === 0 ? "取消" : "上一步"}
              </button>
              <button
                className="primary"
                disabled={
                  !!busy ||
                  !validColumns ||
                  previewPending ||
                  !state.filenames.length
                }
                onClick={step < 2 ? () => go(step + 1) : onImport}
              >
                {busy
                  ? "正在导入…"
                  : step === 0
                    ? "下一步：层位对应"
                    : step === 1
                      ? "下一步：核对导入"
                      : `导入 ${state.filenames.length} 个文件`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
