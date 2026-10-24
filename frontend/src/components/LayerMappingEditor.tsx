import { useEffect, useId, useState } from "react";
import type { HS } from "../types";
import {
  layerColors,
  layerFromName,
  modelGroups,
  modelOf,
  referencePreview,
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

/** The same explicit, reviewable mapping flow for imports and existing models. */
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
      const rows =
        method === "filename"
          ? names.map((name) => ({ name, key: layerFromName(name, model) }))
          : referencePreview(
              names,
              horizons.filter((h) => modelOf(h) === method.slice(6)),
            );
      setPreview(rows);
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
        为每个文件填写真实层位名，例如 T24。同名层位在所有模型中使用同一种颜色。
      </p>
      <div className="mapping-tools">
        <label>
          批量填写
          <select
            aria-label="批量填写方式"
            disabled={disabled}
            value={method}
            onChange={(e) => {
              setMethod(e.target.value);
              setPreview(null);
              setError("");
            }}
          >
            <option value="">选择方式（也可直接逐行填写）</option>
            <option value="filename">从当前文件名提取层位名</option>
            {groups.map((g) => (
              <option key={g.name} value={`model:${g.name}`}>
                沿用 {g.name} 的层位顺序
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary"
          disabled={disabled || !method}
          onClick={generate}
        >
          预览对应
        </button>
      </div>
      {error && (
        <p role="alert" className="mapping-warning">
          {error}
        </p>
      )}
      {preview ? (
        <div className="mapping-preview">
          <div>
            <strong>核对这组对应关系</strong>
            <p className="organization-help">
              {method === "filename"
                ? "已去掉模型前缀或后缀。请确认剩余名称就是实际层位名。"
                : "按两组文件名的数字顺序配对（1、2、…、10）。请确认没有缺层或顺序差异。"}{" "}
              应用后仍可逐行修改。
            </p>
          </div>
          <div className="organization-table-wrap">
            <table className="organization-table">
              <thead>
                <tr>
                  <th>当前文件</th>
                  {method !== "filename" && <th>参照文件</th>}
                  <th>将对应到</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i}>
                    <td>{row.name}</td>
                    {method !== "filename" && <td>{row.reference}</td>}
                    <td>{row.key || "未设置"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mapping-preview-actions">
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => setPreview(null)}
            >
              放弃预览
            </button>
            <button
              className="primary"
              disabled={disabled}
              onClick={() => {
                onChange(preview.map((row) => row.key));
                setPreview(null);
              }}
            >
              应用这组对应
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="organization-table-wrap">
            <table className="organization-table">
              <thead>
                <tr>
                  <th>层位文件</th>
                  <th>对应层位名</th>
                </tr>
              </thead>
              <tbody>
                {names.map((name, index) => (
                  <tr key={index}>
                    <td title={name}>{name}</td>
                    <td>
                      <div className="mapping-value">
                        <span
                          className="layer-color-dot"
                          style={{
                            background:
                              colors.get(keys[index]?.trim()) ||
                              "var(--border)",
                          }}
                        />
                        <input
                          aria-label={`${name} 对应层位`}
                          list={list}
                          maxLength={80}
                          disabled={disabled}
                          value={keys[index] || ""}
                          placeholder="例如 T24，可留空稍后设置"
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {duplicates.size > 0 && (
            <p className="mapping-warning" role="status">
              当前模型有多个文件对应 {Array.from(duplicates).join("、")}
              ，请确认是否为同一层位的分段文件。
            </p>
          )}
          <p className="organization-help">
            已设置 {keys.filter((k) => k.trim()).length} / {names.length}{" "}
            个。留空的文件保留独立颜色。
          </p>
        </>
      )}
    </div>
  );
}
