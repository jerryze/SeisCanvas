import { useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { HS } from "../types";
import {
  layerColors,
  layerOf,
  modelGroups,
  modelOf,
  organizeHorizons,
  patchHorizon,
} from "../horizonOrganization";
import { useModalFocus } from "../hooks/useModalFocus";
import LayerMappingEditor from "./LayerMappingEditor";

type Props = {
  horizons: HS[];
  onClose: () => void;
  onApply: (horizons: HS[]) => void;
};
type Page = "groups" | "mapping" | "colors";
const pages = [
  { id: "groups", title: "1 · 模型分组" },
  { id: "mapping", title: "2 · 层位对应" },
  { id: "colors", title: "3 · 统一配色" },
] as const;

export default function HorizonOrganizationModal({
  horizons,
  onClose,
  onApply,
}: Props) {
  const [draft, setDraft] = useState(() => horizons.map((h) => ({ ...h })));
  const [page, setPage] = useState<Page>("groups");
  const [active, setActive] = useState(
    horizons.some((h) => !modelOf(h))
      ? ""
      : horizons[0]
        ? modelOf(horizons[0])
        : "",
  );
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const [previewPending, setPreviewPending] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const groupList = useId();
  useModalFocus(dialog, true, onClose);
  const groups = modelGroups(draft);
  const current = groups.find((g) => g.name === active) ?? groups[0];
  const members = current?.members ?? [];
  const currentName = current?.name ?? "";
  const shown = members.filter((h) =>
    h.name.toLowerCase().includes(query.toLowerCase()),
  );
  const picked = members.filter((h) => selected.has(h.id));
  const allShown = shown.length > 0 && shown.every((h) => selected.has(h.id));
  const colors = layerColors(draft);
  const missing = draft.filter((h) => !layerOf(h)).length;
  const switchPage = (next: Page) => {
    setPage(next);
    setMessage("");
    setSelected(new Set());
    setQuery("");
  };
  const move = (name: string) => {
    setDraft((currentDraft) =>
      organizeHorizons(
        currentDraft,
        new Map(
          picked.map((h) => [
            h.id,
            { model_group: name, horizon_key: layerOf(h) },
          ]),
        ),
      ),
    );
    setMessage(
      `已将 ${picked.length} 个文件移到${name ? `模型 ${name}` : "未分组"}，保存后生效。`,
    );
    setActive(name);
    setSelected(new Set());
    setQuery("");
    setTarget("");
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal horizon-organization-modal organization-shell"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="层位管理"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>层位管理</h2>
            <p className="organization-help">
              模型决定文件分组，层位名决定统一颜色。
            </p>
          </div>
          <button className="icon" aria-label="关闭层位管理" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="organization-tabs" role="tablist" aria-label="管理内容">
          {pages.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={page === item.id}
              onClick={() => switchPage(item.id)}
            >
              {item.title}
            </button>
          ))}
        </div>
        {page !== "colors" ? (
          <div className="organization-layout">
            <nav className="organization-models" aria-label="选择要管理的模型">
              <span className="organization-nav-label">选择模型</span>
              {groups.map((g) => (
                <button
                  key={g.name}
                  title={g.name || "未分组"}
                  aria-pressed={currentName === g.name}
                  onClick={() => {
                    setActive(g.name);
                    setQuery("");
                    setSelected(new Set());
                    setMessage("");
                  }}
                >
                  <span>{g.name || "未分组"}</span>
                  <small>{g.members.length}</small>
                </button>
              ))}
            </nav>
            <div
              className="organization-editor"
              role="tabpanel"
              aria-label={page === "groups" ? "模型分组" : "层位对应"}
            >
              <div className="organization-section-heading">
                <h3>{currentName || "未分组"}</h3>
                <span>{members.length} 个文件</span>
              </div>
              {page === "groups" ? (
                <>
                  <p className="organization-help">
                    勾选属于同一模型的文件，再将它们移入已有模型或新模型。
                  </p>
                  <input
                    className="organization-search"
                    aria-label="查找层位文件"
                    value={query}
                    placeholder="搜索当前列表中的文件"
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSelected(new Set());
                    }}
                  />
                  <div className="organization-move">
                    <strong>已选 {picked.length} 个文件</strong>
                    <label>
                      移入模型
                      <input
                        aria-label="目标模型名称"
                        list={groupList}
                        maxLength={80}
                        value={target}
                        placeholder="选择已有模型，或输入新名称"
                        onChange={(e) => setTarget(e.target.value)}
                      />
                    </label>
                    <button
                      className="secondary"
                      disabled={
                        !picked.length ||
                        !target.trim() ||
                        target.trim() === currentName
                      }
                      onClick={() => move(target.trim())}
                    >
                      移入模型
                    </button>
                    {currentName && (
                      <button
                        className="text-action"
                        disabled={!picked.length}
                        onClick={() => move("")}
                      >
                        移出模型
                      </button>
                    )}
                  </div>
                  <div className="organization-table-wrap">
                    <table className="organization-table">
                      <thead>
                        <tr>
                          <th>
                            <input
                              type="checkbox"
                              aria-label="选择当前列表全部文件"
                              checked={allShown}
                              ref={(node) => {
                                if (node)
                                  node.indeterminate =
                                    !allShown &&
                                    shown.some((h) => selected.has(h.id));
                              }}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setSelected(
                                  checked
                                    ? new Set(shown.map((h) => h.id))
                                    : new Set(),
                                );
                              }}
                            />
                          </th>
                          <th>层位文件</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((h) => (
                          <tr key={h.id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`选择文件 ${h.name}`}
                                checked={selected.has(h.id)}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setSelected((currentSet) => {
                                    const next = new Set(currentSet);
                                    checked
                                      ? next.add(h.id)
                                      : next.delete(h.id);
                                    return next;
                                  });
                                }}
                              />
                            </td>
                            <td>{h.name}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!shown.length && (
                      <p className="organization-empty">没有匹配的文件。</p>
                    )}
                  </div>
                  <datalist id={groupList}>
                    {groups
                      .filter((g) => g.name && g.name !== currentName)
                      .map((g) => (
                        <option key={g.name} value={g.name} />
                      ))}
                  </datalist>
                  {message && (
                    <p className="organization-message" role="status">
                      {message}
                    </p>
                  )}
                </>
              ) : (
                <LayerMappingEditor
                  key={currentName}
                  model={currentName}
                  names={members.map((h) => h.name)}
                  keys={members.map((h) => h.horizon_key || "")}
                  horizons={draft}
                  onPreviewChange={setPreviewPending}
                  onChange={(keys) =>
                    setDraft((currentDraft) =>
                      organizeHorizons(
                        currentDraft,
                        new Map(
                          members.map((h, i) => [
                            h.id,
                            { model_group: currentName, horizon_key: keys[i] },
                          ]),
                        ),
                      ),
                    )
                  }
                />
              )}
            </div>
          </div>
        ) : (
          <div
            className="organization-editor organization-colors"
            role="tabpanel"
            aria-label="统一配色"
          >
            <div className="organization-section-heading">
              <h3>每个层位，一种颜色</h3>
              <span>{colors.size} 个层位</span>
            </div>
            <p className="organization-help">
              每行代表一个真实层位。修改左侧颜色，会同时更新这一行所有模型的文件。
            </p>
            {colors.size ? (
              <div className="organization-table-wrap">
                <table className="organization-table organization-color-table">
                  <thead>
                    <tr>
                      <th>层位与颜色</th>
                      {groups.map((g) => (
                        <th key={g.name}>{g.name || "未分组"}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...colors].map(([key, color]) => (
                      <tr key={key}>
                        <th>
                          <label>
                            <input
                              type="color"
                              aria-label={`${key} 统一颜色`}
                              value={color}
                              onInput={(e) => {
                                const value = e.currentTarget.value;
                                setDraft((currentDraft) =>
                                  patchHorizon(
                                    currentDraft,
                                    currentDraft.find(
                                      (h) => layerOf(h) === key,
                                    )!.id,
                                    { color: value },
                                  ),
                                );
                              }}
                            />
                            {key}
                          </label>
                        </th>
                        {groups.map((g) => (
                          <td key={g.name}>
                            {g.members
                              .filter((h) => layerOf(h) === key)
                              .map((h) => h.name)
                              .join("、") || (
                              <span className="organization-muted">未对应</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="organization-empty">
                还没有设置层位对应。
                <button
                  className="text-action"
                  onClick={() => switchPage("mapping")}
                >
                  去设置层位对应
                </button>
              </div>
            )}
            {missing > 0 && colors.size > 0 && (
              <p className="organization-help">
                还有 {missing} 个文件未设置对应，暂时使用各自的颜色。
                <button
                  className="text-action"
                  onClick={() => switchPage("mapping")}
                >
                  去设置对应
                </button>
              </p>
            )}
            <p className="organization-help">
              此处设置线条、图例和单色曲面的颜色；时间与振幅色标仍在各视图中设置。
            </p>
          </div>
        )}
        <div className="organization-footer">
          <span>
            {previewPending ? "请先应用或放弃对应预览" : "更改统一在保存后生效"}
          </span>
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={previewPending}
            onClick={() =>
              onApply(
                organizeHorizons(
                  draft,
                  new Map(
                    draft.map((h) => [
                      h.id,
                      { model_group: modelOf(h), horizon_key: layerOf(h) },
                    ]),
                  ),
                ),
              )
            }
          >
            保存更改
          </button>
        </div>
      </div>
    </div>
  );
}
