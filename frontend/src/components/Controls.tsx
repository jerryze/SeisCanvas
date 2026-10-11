import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type SelectHTMLAttributes,
  type InputHTMLAttributes,
  type RefObject,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const controlSizes = [
  ["xs", 72],
  ["sm", 104],
  ["md", 136],
  ["lg", 168],
  ["xl", 200],
] as const;
let textMeasurement: CanvasRenderingContext2D | null = null;

/** Fit content to shared width steps so similar fields keep the same silhouette. */
export function useControlWidth(
  ref: RefObject<HTMLElement | null>,
  text: string,
  inset: number,
  minimum: (typeof controlSizes)[number][0] = "xs",
) {
  const [size, setSize] = useState(minimum);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(ref.current);
    textMeasurement ??= document.createElement("canvas").getContext("2d");
    if (!textMeasurement) return;
    textMeasurement.font = style.font;
    const required =
      textMeasurement.measureText(text).width +
      inset +
      (parseFloat(style.letterSpacing) || 0) * text.length;
    const sizes = controlSizes.slice(
      controlSizes.findIndex(([key]) => key === minimum),
    );
    setSize(
      (sizes.find(
        ([key, fallback]) =>
          required <=
          (parseFloat(style.getPropertyValue(`--panel-control-${key}`)) ||
            fallback),
      ) ?? sizes.at(-1)!)[0],
    );
  }, [ref, text, inset, minimum]);
  const fallback = controlSizes.find(([key]) => key === size)![1];
  return {
    "--control-width": `var(--panel-control-${size}, ${fallback}px)`,
  } as CSSProperties;
}

/** Native selection and keyboard behavior stay intact; only width is standardized. */
export function Select({
  children,
  value,
  defaultValue,
  onChange,
  title,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const select = useRef<HTMLSelectElement>(null);
  const [text, setText] = useState("");
  const widthStyle = useControlWidth(select, text, 40);
  useLayoutEffect(() => {
    setText(select.current?.selectedOptions[0]?.label ?? "");
  }, [children, value, defaultValue]);
  return (
    <span className="select-control" style={widthStyle}>
      <select
        {...props}
        ref={select}
        value={value}
        defaultValue={defaultValue}
        title={title ?? text}
        onChange={(event) => {
          setText(event.currentTarget.selectedOptions[0]?.label ?? "");
          onChange?.(event);
        }}
      >
        {children}
      </select>
    </span>
  );
}

/** Text fields use the same width steps while preserving existing commit behavior. */
export function TextInput({
  value,
  defaultValue,
  onChange,
  onBlur,
  title,
  placeholder,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(String(value ?? defaultValue ?? ""));
  const widthStyle = useControlWidth(input, text || placeholder || "", 16);
  useEffect(
    () => setText(String(value ?? defaultValue ?? "")),
    [value, defaultValue],
  );
  return (
    <span className="text-control" style={widthStyle}>
      <input
        {...props}
        ref={input}
        type="text"
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        title={title ?? text}
        onChange={(event) => {
          setText(event.currentTarget.value);
          onChange?.(event);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          setText(event.currentTarget.value);
        }}
      />
    </span>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
}) {
  return (
    <label className="check" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
export function Num({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  label,
  title,
}: {
  value: number;
  onChange: (v: number) => void | number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  label?: string;
  title?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const characters = Math.max(
    draft.length,
    String(min ?? "").length,
    String(max ?? "").length,
  );
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n)) {
      const v = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
      const committed = onChange(v);
      setDraft(String(committed ?? v));
    } else setDraft(String(value));
  }
  return (
    <input
      className="numeric-input"
      style={
        {
          "--number-width": `var(--panel-number-${characters <= 4 ? "short" : characters <= 7 ? "medium" : "long"})`,
        } as CSSProperties
      }
      type="number"
      aria-label={label}
      title={title}
      disabled={disabled}
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/** Percentages are a display unit; view state continues to store 0–1 values. */
export function OpacityControl({
  value,
  onChange,
  disabled = false,
  label = "透明度",
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label className="section-number">
      <span>透明度</span>
      <span className="number-unit">
        <Num
          label={`${label}（%）`}
          title="透明度（0–100%）"
          disabled={disabled}
          value={Number((value * 100).toFixed(6))}
          min={0}
          max={100}
          step={5}
          onChange={(percent) => onChange(percent / 100)}
        />
        <span aria-hidden="true">%</span>
      </span>
    </label>
  );
}

/** Related stroke controls share a single baseline and keep native tooltips. */
export function StrokeControl({
  label,
  visible,
  color,
  width,
  onVisible,
  onColor,
  onWidth,
  disabled = false,
  disableColorWhenHidden = true,
}: {
  label: string;
  visible: boolean;
  color: string;
  width: number;
  onVisible: (visible: boolean) => void;
  onColor: (color: string) => void;
  onWidth: (width: number) => void;
  disabled?: boolean;
  disableColorWhenHidden?: boolean;
}) {
  return (
    <div className="stroke-row" role="group" aria-label={label}>
      <label className="check">
        <span>{label}</span>
        <input
          type="checkbox"
          aria-label={`显示${label}`}
          title={`显示${label}`}
          disabled={disabled}
          checked={visible}
          onChange={(e) => onVisible(e.target.checked)}
        />
      </label>
      <input
        type="color"
        aria-label={`${label}颜色`}
        title={`${label}颜色`}
        disabled={(disableColorWhenHidden && !visible) || disabled}
        value={color}
        onChange={(e) => onColor(e.target.value)}
      />
      <Num
        label={`${label}宽度（pt）`}
        title={`${label}宽度（pt）`}
        disabled={!visible || disabled}
        value={width}
        min={0.2}
        max={6}
        step={0.1}
        onChange={onWidth}
      />
    </div>
  );
}
export function Group({
  icon,
  title,
  children,
  defaultOpen = true,
  hint,
  hintTitle,
  count,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  hint?: React.ReactNode;
  hintTitle?: string;
  count?: number;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary>
        <span className="group-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="group-title">
          {title}
          {count !== undefined && (
            <span className="group-count"> · {count}</span>
          )}
        </span>
        <small
          className="group-summary-hint"
          title={hintTitle ?? (typeof hint === "string" ? hint : undefined)}
        >
          {hint}
        </small>
        <ChevronDown className="group-chevron" size={16} strokeWidth={1.75} />
      </summary>
      <div className="group-body">{children}</div>
    </details>
  );
}

/** Shared structure for native sidebar disclosures; details owns its toggle. */
export function SubsectionSummary({
  title,
  hint,
  tooltip,
}: {
  title: string;
  hint?: string;
  tooltip?: string;
}) {
  return (
    <summary className="subsection-summary" title={tooltip}>
      <ChevronRight
        className="subsection-chevron"
        size={16}
        strokeWidth={1.75}
      />
      <span>{title}</span>
      {hint && (
        <small className="group-summary-hint" title={hint}>
          {hint}
        </small>
      )}
    </summary>
  );
}
