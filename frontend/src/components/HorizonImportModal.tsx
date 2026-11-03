import { Check, FileText, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import type { HS } from "../types";
import { layerColors, modelGroups } from "../horizonOrganization";
import LayerMappingEditor from "./LayerMappingEditor";

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
const steps = ["数据与分组", "层位对应", "确认导入"];
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
  const groupList = useId();
  const [step, setStep] = useState(0);
  const [previewPending, setPreviewPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const groups = modelGroups(horizons).filter((g) => g.name);
  const group = state.model_group.trim();
  const existing = groups.find((g) => g.name === group);
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
  const close = () => {
    if (!busy) setClosing(true);
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
    return column ? `第 ${column.index + 1} 列 / ${column.name}` : "未选择";
  };
  return (
    <div className="modal-backdrop">
      <div
        className="modal horizon-import-modal organization-shell"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="导入层位"
        aria-busy={!!busy}
      >
        <div className="modal-heading">
          <div>
            <h2>导入层位</h2>
            <div className="import-overview">
              <span>{state.filenames.length} 个文件</span>
              <span>导入到当前项目</span>
            </div>
          </div>
          <button
            className="icon"
            aria-label="关闭层位导入"
            disabled={!!busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <ol className="import-steps" aria-label="导入步骤">
          {steps.map((label, i) => (
            <li
              key={label}
              aria-current={step === i ? "step" : undefined}
              className={i < step ? "is-complete" : undefined}
            >
              <span className="import-step-number">
                {i < step ? <Check size={13} /> : i + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
        <div className={`import-stage import-stage-${step}`}>
          {step === 0 ? (
            <div className="import-setup">
              <aside className="import-file-panel" aria-label="本次导入文件">
                <div className="organization-section-heading">
                  <h3>已选文件</h3>
                  <span>{state.filenames.length}</span>
                </div>
                <ol className="import-file-list">
                  {state.filenames.map((name, i) => (
                    <li key={i}>
                      <FileText size={15} />
                      <span className="horizon-file-label" title={name}>
                        {name}
                      </span>
                      {i === 0 && (
                        <span className="file-preview-tag">预览</span>
                      )}
                    </li>
                  ))}
                </ol>
              </aside>
              <div className="import-configuration">
                <div className="organization-section-heading">
                  <h3 ref={heading} tabIndex={-1}>
                    导入设置
                  </h3>
                  <span>应用于本批全部文件</span>
                </div>
                <section className="import-settings-section">
                  <label className="import-model-field">
                    所属分组
                    <input
                      aria-label="导入所属分组"
                      list={groupList}
                      maxLength={80}
                      value={state.model_group}
                      disabled={!!busy}
                      placeholder="选择已有分组或输入新名称"
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
                    {!group
                      ? "留空则放入未分组。"
                      : existing
                        ? `加入已有分组，当前 ${existing.members.length} 个文件。`
                        : "将创建此分组。"}
                  </p>
                </section>
                <section className="import-settings-section">
                  <div className="organization-section-heading">
                    <h3>数据列</h3>
                    <span>整批文件使用相同列顺序</span>
                  </div>
                  <div className="column-selects">
                    {columnFields.map(([key, label]) => (
                      <label className="field" key={key}>
                        {label}
                        <select
                          disabled={!!busy}
                          value={state[key]}
                          onChange={(e) =>
                            onColumn(key, Number(e.target.value))
                          }
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
                </section>
                <section className="import-settings-section import-preview-section">
                  <div className="import-preview-label">
                    <h3>原始数据预览</h3>
                    <span className="horizon-file-label" title={state.filename}>
                      {state.filename}
                    </span>
                  </div>
                  <div
                    className="organization-table-wrap import-data-preview"
                    tabIndex={0}
                    aria-label="原始数据预览表格"
                  >
                    <table className="organization-table">
                      <thead>
                        <tr>
                          {state.columns.map((c) => {
                            const field = columnFields
                              .filter(([key]) => state[key] === c.index)
                              .map(([, label]) => label)
                              .join(" / ");
                            return (
                              <th key={c.index}>
                                <span>
                                  {c.index + 1}. {c.name}
                                </span>
                                {field && (
                                  <small className="column-assignment">
                                    {field}
                                  </small>
                                )}
                              </th>
                            );
                          })}
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
                </section>
              </div>
            </div>
          ) : (
            <div className="organization-editor">
              <div className="organization-section-heading">
                <div>
                  <h3 ref={heading} tabIndex={-1}>
                    {step === 1 ? "设置层位对应" : "核对导入清单"}
                  </h3>
                  <span className="organization-muted">
                    {group || "未分组"}
                  </span>
                </div>
                <span>
                  {mapped} 个已对应 / {missing} 个未对应
                </span>
              </div>
              {step === 1 ? (
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
                      <dd title={group}>
                        {group || "未分组"}
                        <span>
                          {!group ? "" : existing ? "已有分组" : "新建分组"}
                        </span>
                      </dd>
                    </div>
                    {columnFields.map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd title={columnName(key)}>{columnName(key)}</dd>
                      </div>
                    ))}
                  </dl>
                  <div
                    className="organization-table-wrap"
                    tabIndex={0}
                    aria-label="导入文件核对清单"
                  >
                    <table className="organization-table import-review-table">
                      <colgroup>
                        <col />
                        <col style={{ width: "24%" }} />
                        <col style={{ width: "24%" }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>层位文件</th>
                          <th>对应层位</th>
                          <th>配色</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.filenames.map((name, i) => {
                          const key = state.horizon_keys[i]?.trim() || "",
                            color = colors.get(key);
                          return (
                            <tr key={i}>
                              <td>
                                <span
                                  className="horizon-file-label"
                                  title={name}
                                >
                                  {name}
                                </span>
                              </td>
                              <td>
                                <span
                                  className={
                                    key
                                      ? "horizon-file-label"
                                      : "organization-muted"
                                  }
                                  title={key}
                                >
                                  {key || "未对应"}
                                </span>
                              </td>
                              <td>
                                <span className="import-color-source">
                                  {color && (
                                    <span
                                      className="layer-color-dot"
                                      style={{ background: color }}
                                    />
                                  )}
                                  {color
                                    ? "沿用统一颜色"
                                    : key
                                      ? "新建统一颜色"
                                      : "独立颜色"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {missing > 0 && (
                    <p className="organization-help">
                      {missing}{" "}
                      个未对应文件将保留独立颜色，可在层位管理中继续设置。
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        {error && (
          <p className="mapping-warning import-error" role="alert">
            导入未完成：{error}
          </p>
        )}
        <div
          className={`organization-footer${closing ? " organization-footer-confirm" : ""}`}
        >
          <span role="status">
            {busy ||
              (closing
                ? "放弃后需重新选择文件"
                : previewPending
                  ? "对应预览尚未应用"
                  : `第 ${step + 1} 步，共 3 步`)}
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
                      ? "下一步：确认导入"
                      : `导入 ${state.filenames.length} 个文件`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
