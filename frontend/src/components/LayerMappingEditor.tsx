import { useEffect, useId, useState } from "react";
import { Search } from "lucide-react";
import type { HS } from "../types";
import {
  layerColors,
  layerFromName,
  modelGroups,
  modelOf,
  referencePreview,
  mappingRows,
} from "../horizonOrganization";

type Props = {
  names: string[];
  keys: string[];
  model: string;
  horizons: HS[];
  disabled?: boolean;
  onChange: (keys: string[]) => void;
  onPreviewChange?: (pending: boolean) => void;
};

/** Imports and existing files use the same editable, explicitly applied mapping. */
export default function LayerMappingEditor({
  names,
  keys,
  model,
  horizons,
  disabled = false,
  onChange,
  onPreviewChange,
}: Props) {
  const list = useId();
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [query, setQuery] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [preview, setPreview] = useState<
    { name: string; key: string; reference?: string }[] | null
  >(null);
  const [error, setError] = useState("");
  useEffect(() => {
    onPreviewChange?.(preview !== null);
    return () => onPreviewChange?.(false);
  }, [preview, onPreviewChange]);
  const groups = modelGroups(horizons).filter(
    (g) => g.name && g.name !== model.trim(),
  );
  const colors = layerColors(horizons);
  const mapped = keys.filter((k) => k.trim()).length;
  const rows = mappingRows(names, keys, query, onlyMissing);
  const duplicates = new Set(
    keys
      .filter(
        (key, i) =>
          key.trim() && keys.findIndex((k) => k.trim() === key.trim()) !== i,
      )
      .map((k) => k.trim()),
  );
  const generate = () => {
    try {
      setPreview(
        method === "filename"
          ? names.map((name) => ({ name, key: layerFromName(name, model) }))
          : referencePreview(
              names,
              horizons.filter((h) => modelOf(h) === reference),
            ),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="layer-mapping-editor">
      <datalist id={list}>
        {[...colors.keys()].map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>
      <p className="organization-help">
        对应层位名相同的文件，共用一种颜色。留空可稍后设置。
      </p>
      <div className="mapping-tools">
        <label>
          批量填写
          <select
            aria-label="批量填写方式"
            disabled={disabled || !!preview}
            value={method}
            onChange={(e) => {
              setMethod(e.target.value);
              setError("");
            }}
          >
            <option value="">逐行设置</option>
            <option value="filename">从文件名提取</option>
            {!!groups.length && <option value="reference">参照其他分组</option>}
          </select>
        </label>
        {method === "reference" && (
          <label>
            参照分组
            <select
              aria-label="参照分组"
              disabled={disabled || !!preview}
              value={reference}
              onChange={(e) => {
                setReference(e.target.value);
                setError("");
              }}
            >
              <option value="">选择分组</option>
              {groups.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name}（{g.members.length} 个文件）
                </option>
              ))}
            </select>
          </label>
        )}
        {!!method && (
          <button
            className="secondary"
            disabled={
              disabled || !!preview || (method === "reference" && !reference)
            }
            onClick={generate}
          >
            预览整组对应
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mapping-warning">
          {error}
        </p>
      )}
      {preview ? (
        <div className="mapping-preview">
          <div className="mapping-preview-heading">
            <strong>核对批量对应</strong>
            <span className="mapping-status pending">尚未应用</span>
          </div>
          <p className="organization-help">
            {method === "filename"
              ? "提取结果如下，可应用后逐行修改。"
              : "按文件名自然顺序配对，请核对缺层与顺序差异。"}
          </p>
          <div
            className="organization-table-wrap"
            tabIndex={0}
            aria-label="批量对应预览列表"
          >
            <table className="organization-table mapping-preview-table">
              <thead>
                <tr>
                  <th>当前文件</th>
                  {method === "reference" && <th>参照文件</th>}
                  <th>对应层位</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i}>
                    <td>
                      <span className="horizon-file-label" title={row.name}>
                        {row.name}
                      </span>
                    </td>
                    {method === "reference" && (
                      <td>
                        <span
                          className="horizon-file-label"
                          title={row.reference}
                        >
                          {row.reference}
                        </span>
                      </td>
                    )}
                    <td>
                      <span className="horizon-file-label" title={row.key}>
                        {row.key || "未对应"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mapping-preview-actions">
            <span>{preview.length} 个文件</span>
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => setPreview(null)}
            >
              取消预览
            </button>
            <button
              className="primary"
              disabled={disabled}
              onClick={() => {
                onChange(preview.map((row) => row.key));
                setPreview(null);
              }}
            >
              应用对应
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mapping-list-tools">
            <label className="horizon-search">
              <Search size={15} />
              <input
                aria-label="搜索文件或层位"
                placeholder="搜索文件或层位"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label className="mapping-filter">
              <input
                type="checkbox"
                checked={onlyMissing}
                onChange={(e) => setOnlyMissing(e.target.checked)}
              />
              仅未对应 <span>{names.length - mapped}</span>
            </label>
          </div>
          <div
            className="organization-table-wrap"
            tabIndex={0}
            aria-label="文件与层位对应列表"
          >
            <table className="organization-table mapping-table">
              <colgroup>
                <col />
                <col className="mapping-key-column" />
                <col className="mapping-status-column" />
              </colgroup>
              <thead>
                <tr>
                  <th>层位文件</th>
                  <th>对应层位</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ name, index }) => {
                  const key = keys[index]?.trim() || "";
                  return (
                    <tr key={index}>
                      <td>
                        <span className="horizon-file-label" title={name}>
                          {name}
                        </span>
                      </td>
                      <td>
                        <div className="mapping-value">
                          <span
                            className="layer-color-dot"
                            style={{
                              background: colors.get(key) || "var(--border)",
                            }}
                          />
                          <input
                            aria-label={`${name} 对应层位`}
                            list={list}
                            maxLength={80}
                            disabled={disabled}
                            value={keys[index] || ""}
                            placeholder="选择或输入，如 T24"
                            onChange={(e) =>
                              onChange(
                                names.map((_, i) =>
                                  i === index ? e.target.value : keys[i] || "",
                                ),
                              )
                            }
                          />
                        </div>
                      </td>
                      <td>
                        <span
                          className={`mapping-status ${!key || duplicates.has(key) ? "pending" : "complete"}`}
                        >
                          {!key
                            ? "未对应"
                            : duplicates.has(key)
                              ? "重复对应"
                              : "已对应"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length && (
              <div className="organization-empty">
                {onlyMissing && mapped === names.length
                  ? "所有文件均已对应"
                  : "没有匹配的文件"}
              </div>
            )}
          </div>
          <div className="mapping-list-summary">
            <span>
              显示 {rows.length} / {names.length} 个文件
            </span>
            <span>已对应 {mapped} 个</span>
          </div>
          {duplicates.size > 0 && (
            <p className="mapping-warning" role="status">
              多个文件对应 {Array.from(duplicates).join("、")}
              。若不是同一层位的分段文件，请调整。
            </p>
          )}
        </>
      )}
    </div>
  );
}
