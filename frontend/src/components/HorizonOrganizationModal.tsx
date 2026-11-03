import { useId, useRef, useState } from "react";
import { Folder, Search, X } from "lucide-react";
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
  { id: "groups", title: "分组管理" },
  { id: "mapping", title: "层位对应" },
  { id: "colors", title: "统一配色" },
] as const;

export default function HorizonOrganizationModal({
  horizons,
  onClose,
  onApply,
}: Props) {
  const [draft, setDraft] = useState(() => horizons.map((h) => ({ ...h })));
  const [page, setPage] = useState<Page>("groups");
  // null is the cross-model file list; an empty name is the ungrouped model.
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const [previewPending, setPreviewPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const id = useId();
  const groups = modelGroups(draft);
  const current = groups.find((g) => g.name === active) ?? groups[0];
  const allFiles = page === "groups" && active === null;
  const members = allFiles ? draft : (current?.members ?? []);
  const currentName = current?.name ?? "";
  const shown = members.filter((h) =>
    [h.name, modelOf(h), layerOf(h)].some((value) =>
      value.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  const picked = members.filter((h) => selected.has(h.id));
  const allShown = shown.length > 0 && shown.every((h) => selected.has(h.id));
  const colors = layerColors(draft);
  const missing = draft.filter((h) => !layerOf(h)).length;
  const original = new Map(horizons.map((h) => [h.id, h]));
  const changed = draft.filter((h) => {
    const before = original.get(h.id);
    return (
      !before ||
      modelOf(before) !== modelOf(h) ||
      layerOf(before) !== layerOf(h) ||
      before.color !== h.color
    );
  }).length;
  const close = () =>
    changed || previewPending ? setClosing(true) : onClose();
  useModalFocus(dialog, true, close);

  const switchPage = (next: Page) => {
    if (previewPending || next === page) return;
    setPage(next);
    if (next === "mapping" && active === null) setActive(currentName);
    setMessage("");
    setSelected(new Set());
    setQuery("");
    setTarget("");
    setClosing(false);
  };
  const chooseModel = (name: string | null) => {
    if (previewPending) return;
    setActive(name);
    setSelected(new Set());
    setQuery("");
    setTarget("");
    setMessage("");
  };
  const goToMapping = (name: string) => {
    chooseModel(name);
    setPage("mapping");
    setClosing(false);
  };
  const move = (name: string) => {
    setDraft((rows) =>
      organizeHorizons(
        rows,
        new Map(
          picked.map((h) => [
            h.id,
            { model_group: name, horizon_key: layerOf(h) },
          ]),
        ),
      ),
    );
    setMessage(
      `已将 ${picked.length} 个文件${name ? `移至分组 ${name}` : "移至未分组"}`,
    );
    setActive(name);
    setSelected(new Set());
    setQuery("");
    setTarget("");
  };
  const save = () =>
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
    );
  const unresolvedGroup = groups.find((g) =>
    g.members.some((h) => !layerOf(h)),
  );

  return (
    <div className="modal-backdrop">
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
            <div className="organization-overview">
              <span>{groups.filter((g) => g.name).length} 个分组</span>
              <span>{draft.length} 个文件</span>
              <span
                className={`mapping-status ${missing ? "pending" : "complete"}`}
              >
                {!draft.length
                  ? "尚未添加文件"
                  : missing
                    ? `${missing} 个未对应`
                    : "层位已全部对应"}
              </span>
            </div>
          </div>
          <button className="icon" aria-label="关闭层位管理" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <div
          className="organization-tabs"
          ref={tabs}
          role="tablist"
          aria-label="管理内容"
        >
          {pages.map((item, index) => (
            <button
              key={item.id}
              id={`${id}-${item.id}-tab`}
              role="tab"
              aria-selected={page === item.id}
              aria-controls={`${id}-${item.id}-panel`}
              tabIndex={page === item.id ? 0 : -1}
              disabled={previewPending && page !== item.id}
              onClick={() => switchPage(item.id)}
              onKeyDown={(e) => {
                if (
                  previewPending ||
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                )
                  return;
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? pages.length - 1
                      : (index +
                          (e.key === "ArrowRight" ? 1 : -1) +
                          pages.length) %
                        pages.length;
                switchPage(pages[next].id);
                tabs.current
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
            >
              {item.title}
            </button>
          ))}
        </div>
        {page !== "colors" ? (
          <div className="organization-layout">
            <nav className="organization-models" aria-label="选择要管理的分组">
              <span className="organization-nav-label">分组</span>
              {page === "groups" && (
                <button
                  aria-pressed={allFiles}
                  disabled={previewPending}
                  onClick={() => chooseModel(null)}
                >
                  <span className="organization-group-name">
                    <Folder size={15} />
                    全部文件
                  </span>
                  <small>{draft.length}</small>
                </button>
              )}
              {groups.map((g) => (
                <button
                  key={g.name}
                  title={g.name || "未分组"}
                  aria-pressed={!allFiles && currentName === g.name}
                  disabled={previewPending}
                  onClick={() => chooseModel(g.name)}
                >
                  <span className="organization-group-name">
                    <Folder size={15} />
                    <span>{g.name || "未分组"}</span>
                  </span>
                  <small>{g.members.length}</small>
                </button>
              ))}
            </nav>
            <div
              className="organization-editor"
              role="tabpanel"
              id={`${id}-${page}-panel`}
              aria-labelledby={`${id}-${page}-tab`}
            >
              <div className="organization-section-heading">
                <div>
                  <h3>{allFiles ? "全部文件" : currentName || "未分组"}</h3>
                  <span className="organization-muted">
                    {members.length} 个文件
                    {page === "mapping"
                      ? `，${members.filter((h) => !layerOf(h)).length} 个未对应`
                      : ""}
                  </span>
                </div>
                {page === "groups" && !allFiles && members.length > 0 && (
                  <button
                    className="secondary"
                    onClick={() => goToMapping(currentName)}
                  >
                    设置层位对应
                  </button>
                )}
              </div>
              {page === "groups" ? (
                <>
                  <div className="organization-list-tools">
                    <label className="horizon-search">
                      <Search size={15} />
                      <input
                        aria-label="查找层位文件"
                        value={query}
                        placeholder="搜索文件、分组或层位"
                        onChange={(e) => {
                          setQuery(e.target.value);
                          setSelected(new Set());
                        }}
                      />
                    </label>
                    <span className="organization-muted">
                      {picked.length
                        ? `已选 ${picked.length} 个`
                        : `${shown.length} 个文件`}
                    </span>
                  </div>
                  {picked.length > 0 && (
                    <div
                      className="organization-move"
                      aria-label="批量移动所选文件"
                    >
                      <label>
                        将 {picked.length} 个文件移至
                        <input
                          aria-label="目标分组名称"
                          list={`${id}-models`}
                          maxLength={80}
                          value={target}
                          placeholder="选择分组或输入新分组名称"
                          onChange={(e) => setTarget(e.target.value)}
                        />
                      </label>
                      <button
                        className="secondary"
                        disabled={
                          !target.trim() ||
                          picked.every((h) => modelOf(h) === target.trim())
                        }
                        onClick={() => move(target.trim())}
                      >
                        应用分组
                      </button>
                      {picked.some((h) => modelOf(h)) && (
                        <button
                          className="text-action"
                          onClick={() => move("")}
                        >
                          移至未分组
                        </button>
                      )}
                      <button
                        className="text-action"
                        onClick={() => setSelected(new Set())}
                      >
                        取消选择
                      </button>
                    </div>
                  )}
                  {message && (
                    <p className="organization-message" role="status">
                      {message}，保存后生效。
                    </p>
                  )}
                  <div
                    className="organization-table-wrap"
                    tabIndex={0}
                    aria-label="分组文件列表"
                  >
                    <table className="organization-table organization-files-table">
                      <colgroup>
                        <col style={{ width: 44 }} />
                        <col />
                        <col style={{ width: "21%" }} />
                        <col style={{ width: "21%" }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>
                            <input
                              type="checkbox"
                              aria-label="选择当前列表全部文件"
                              checked={allShown}
                              disabled={!shown.length}
                              ref={(node) => {
                                if (node)
                                  node.indeterminate =
                                    !allShown &&
                                    shown.some((h) => selected.has(h.id));
                              }}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? new Set(shown.map((h) => h.id))
                                    : new Set(),
                                )
                              }
                            />
                          </th>
                          <th>层位文件</th>
                          <th>所属分组</th>
                          <th>对应层位</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((h) => (
                          <tr
                            key={h.id}
                            className={
                              selected.has(h.id) ? "is-selected" : undefined
                            }
                          >
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`选择文件 ${h.name}`}
                                id={`${id}-file-${h.id}`}
                                checked={selected.has(h.id)}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setSelected((value) => {
                                    const next = new Set(value);
                                    checked
                                      ? next.add(h.id)
                                      : next.delete(h.id);
                                    return next;
                                  });
                                }}
                              />
                            </td>
                            <td>
                              <label
                                className="horizon-file-label"
                                htmlFor={`${id}-file-${h.id}`}
                                title={h.name}
                              >
                                {h.name}
                              </label>
                            </td>
                            <td>
                              {modelOf(h) ? (
                                <span
                                  className="horizon-file-label"
                                  title={modelOf(h)}
                                >
                                  {modelOf(h)}
                                </span>
                              ) : (
                                <span className="organization-muted">
                                  未分组
                                </span>
                              )}
                            </td>
                            <td>
                              {layerOf(h) ? (
                                <span className="organization-layer-name">
                                  <span
                                    className="layer-color-dot"
                                    style={{ background: h.color }}
                                  />
                                  <span
                                    className="horizon-file-label"
                                    title={layerOf(h)}
                                  >
                                    {layerOf(h)}
                                  </span>
                                </span>
                              ) : (
                                <span className="mapping-status pending">
                                  未对应
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!shown.length && (
                      <p className="organization-empty">
                        {draft.length ? "没有匹配的文件" : "请先添加层位文件"}
                      </p>
                    )}
                  </div>
                  <p className="organization-help">
                    勾选文件可批量移动分组；层位对应和颜色保持不变。
                  </p>
                  <datalist id={`${id}-models`}>
                    {groups
                      .filter((g) => g.name)
                      .map((g) => (
                        <option key={g.name} value={g.name} />
                      ))}
                  </datalist>
                </>
              ) : members.length ? (
                <LayerMappingEditor
                  key={currentName}
                  model={currentName}
                  names={members.map((h) => h.name)}
                  keys={members.map(layerOf)}
                  horizons={draft}
                  onPreviewChange={setPreviewPending}
                  onChange={(keys) =>
                    setDraft((rows) =>
                      organizeHorizons(
                        rows,
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
              ) : (
                <p className="organization-empty">请先添加层位文件</p>
              )}
            </div>
          </div>
        ) : (
          <div
            className="organization-editor organization-colors"
            role="tabpanel"
            id={`${id}-colors-panel`}
            aria-labelledby={`${id}-colors-tab`}
          >
            <div className="organization-section-heading">
              <h3>跨分组统一配色</h3>
              <span>{colors.size} 个统一层位</span>
            </div>
            <p className="organization-help">
              每行代表同一层位，修改颜色会同步到该行所有文件。
            </p>
            {colors.size ? (
              <div
                className="organization-table-wrap"
                tabIndex={0}
                aria-label="跨分组层位配色表"
              >
                <table className="organization-table organization-color-table">
                  <thead>
                    <tr>
                      <th>层位与颜色</th>
                      {groups.map((g) => (
                        <th key={g.name}>
                          <span
                            className="horizon-file-label"
                            title={g.name || "未分组"}
                          >
                            {g.name || "未分组"}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...colors].map(([key, color]) => (
                      <tr key={key}>
                        <th scope="row">
                          <label>
                            <input
                              type="color"
                              aria-label={`${key} 统一颜色`}
                              value={color}
                              onInput={(e) => {
                                const value = e.currentTarget.value;
                                setDraft((rows) =>
                                  patchHorizon(
                                    rows,
                                    rows.find((h) => layerOf(h) === key)!.id,
                                    { color: value },
                                  ),
                                );
                              }}
                            />
                            <span className="horizon-file-label" title={key}>
                              {key}
                            </span>
                          </label>
                        </th>
                        {groups.map((g) => (
                          <td key={g.name}>
                            {g.members.some((h) => layerOf(h) === key) ? (
                              g.members
                                .filter((h) => layerOf(h) === key)
                                .map((h) => (
                                  <span
                                    className="horizon-file-label"
                                    key={h.id}
                                    title={h.name}
                                  >
                                    {h.name}
                                  </span>
                                ))
                            ) : (
                              <button
                                className="text-action organization-missing-link"
                                aria-label={`检查 ${g.name || "未分组"} 的 ${key} 对应`}
                                onClick={() => goToMapping(g.name)}
                              >
                                无对应文件
                              </button>
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
                尚未设置层位对应
                <button
                  className="text-action"
                  onClick={() => goToMapping(currentName)}
                >
                  去设置对应
                </button>
              </div>
            )}
            {missing > 0 && colors.size > 0 && (
              <div className="organization-unmapped">
                <span>{missing} 个文件未对应，暂时保留独立颜色</span>
                <button
                  className="text-action"
                  onClick={() =>
                    goToMapping(unresolvedGroup?.name ?? currentName)
                  }
                >
                  处理未对应文件
                </button>
              </div>
            )}
          </div>
        )}
        <div
          className={`organization-footer${closing ? " organization-footer-confirm" : ""}`}
        >
          <span role="status">
            {closing
              ? "关闭将放弃本次未保存的更改"
              : previewPending
                ? "请先应用或取消当前对应预览"
                : changed
                  ? `${changed} 个文件有更改，保存后生效`
                  : "暂无未保存更改"}
          </span>
          {closing ? (
            <>
              <button className="secondary" onClick={() => setClosing(false)}>
                继续编辑
              </button>
              <button className="secondary danger" onClick={onClose}>
                放弃更改
              </button>
            </>
          ) : (
            <button className="secondary" onClick={close}>
              {changed || previewPending ? "取消" : "关闭"}
            </button>
          )}
          <button
            className="primary"
            disabled={previewPending || !changed}
            onClick={save}
          >
            {closing ? "保存并关闭" : "保存更改"}
          </button>
        </div>
      </div>
    </div>
  );
}
