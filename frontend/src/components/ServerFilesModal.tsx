import { useRef, useState } from "react";
import { useModalFocus } from "../hooks/useModalFocus";

export default function ServerFilesModal({ kind, multiple, onDone }: {
  kind: string;
  multiple: boolean;
  onDone: (paths: string[] | null) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const paths = value.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
  const valid = paths.length > 0 && (multiple || paths.length === 1)
    && paths.every(path => path.startsWith("/") || path.startsWith("~/"));
  useModalFocus(dialog, true, () => onDone(null));
  return (
    <div className="modal-backdrop" onClick={() => onDone(null)}>
      <div className="modal" ref={dialog} tabIndex={-1} role="dialog"
        aria-modal="true" aria-label={`选择${kind === "SEG-Y" ? " SEG-Y " : kind}文件`}
        onClick={event => event.stopPropagation()}>
        <h2>选择{kind === "SEG-Y" ? " SEG-Y " : kind}文件</h2>
        <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {multiple ? "文件路径（每行一个）" : "文件路径"}
          <textarea aria-label="文件路径" rows={multiple ? 6 : 2}
            value={value} onChange={event => setValue(event.target.value)}
            placeholder={kind === "SEG-Y" ? "/data/survey.segy" : "/data/horizons/T24.txt"}
            spellCheck={false} style={{ width: "100%", padding: 10, boxSizing: "border-box", resize: "vertical" }} />
        </label>
        <div className="import-actions">
          <button className="secondary" onClick={() => onDone(null)}>取消</button>
          <button className="primary" disabled={!valid} onClick={() => onDone(paths)}>读取文件</button>
        </div>
      </div>
    </div>
  );
}
