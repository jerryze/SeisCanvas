import { useRef, useState } from "react";
import { X } from "lucide-react";
import { useModalFocus } from "../hooks/useModalFocus";

export default function ServerFilesModal({
  kind,
  multiple,
  onDone,
}: {
  kind: string;
  multiple: boolean;
  onDone: (paths: string[] | null) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const paths = value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  const valid =
    paths.length > 0 &&
    (multiple || paths.length === 1) &&
    paths.every((path) => path.startsWith("/") || path.startsWith("~/"));
  useModalFocus(dialog, true, () => onDone(null));
  return (
    <div className="modal-backdrop">
      <div
        className="modal server-files-dialog"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`选择${kind === "SEG-Y" ? " SEG-Y " : kind}文件`}
      >
        <div className="modal-heading">
          <h2>选择{kind === "SEG-Y" ? " SEG-Y " : kind}文件</h2>
          <button
            className="icon"
            aria-label="关闭文件选择"
            onClick={() => onDone(null)}
          >
            <X size={20} />
          </button>
        </div>
        <label className="server-path-field">
          {multiple ? "文件路径（每行一个）" : "文件路径"}
          <textarea
            aria-label="文件路径"
            rows={multiple ? 6 : 2}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              kind === "SEG-Y" ? "/data/survey.segy" : "/data/horizons/T24.txt"
            }
            spellCheck={false}
            aria-describedby="server-path-help"
          />
        </label>
        <p id="server-path-help" className="organization-help">
          {value.trim() && !valid
            ? multiple
              ? "请输入以 / 或 ~/ 开头的完整路径，每行一个。"
              : "请输入一个以 / 或 ~/ 开头的完整路径。"
            : "填写运行 SeisCanvas 的电脑上的完整文件路径。"}
        </p>
        <div className="import-actions">
          <button className="secondary" onClick={() => onDone(null)}>
            取消
          </button>
          <button
            className="primary"
            disabled={!valid}
            onClick={() => onDone(paths)}
          >
            读取文件
          </button>
        </div>
      </div>
    </div>
  );
}
