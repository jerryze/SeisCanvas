import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { useControlWidth } from "./Controls";
import "./colormapSelect.css";

export type ColorScale = ReadonlyArray<readonly [number, string]>;
export type ColormapOption = {
  value: string;
  label: string;
  colors: ColorScale;
};

/** Keep positions and endpoints, including unevenly spaced color stops. */
export function colormapGradient(colors: ColorScale, reverse = false) {
  const stops = colors.map(
    ([position, color]) => [reverse ? 1 - position : position, color] as const,
  );
  if (reverse) stops.reverse();
  return stops.length
    ? `linear-gradient(to right, ${stops.map(([position, color]) => `${color} ${position * 100}%`).join(", ")})`
    : undefined;
}
export function colormapOptions(maps: Record<string, any[]>): ColormapOption[] {
  return Object.entries(maps).map(([value, colors]) => ({
    value,
    label: value,
    colors,
  }));
}

/** A compact, keyboard-accessible select. Its portal never changes sidebar layout. */
export default function ColormapSelect({
  label,
  value,
  options,
  onChange,
  reverse = false,
  range,
  disabled = false,
}: {
  label: string;
  value: string;
  options: ColormapOption[];
  onChange?: (value: string) => void;
  reverse?: boolean;
  range?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 240,
  });
  const selected = options.findIndex((option) => option.value === value);
  const current = options[selected];
  const widthStyle = useControlWidth(trigger, current?.label || value, 110, "md");
  const unavailable = disabled || !options.length;

  useLayoutEffect(() => {
    if (!open || unavailable) {
      setOpen(false);
      return;
    }
    const rect = trigger.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const height = Math.min(240, options.length * 30 + 8);
    const upward = below < height && above > below;
    const maxHeight = Math.max(
      30,
      Math.min(height, (upward ? above : below) - 4),
    );
    const width = Math.min(Math.max(rect.width, 184), window.innerWidth - 16);
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: upward ? rect.top - maxHeight - 4 : rect.bottom + 4,
      width,
      maxHeight,
    });
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!trigger.current?.contains(node) && !menu.current?.contains(node))
        setOpen(false);
    };
    const closeOnScroll = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return;
      // A focus/click can deliver a delayed scroll event after we measured the
      // final anchor. Close only when the control actually moves.
      const currentRect = trigger.current?.getBoundingClientRect();
      if (!currentRect || Math.abs(currentRect.top - rect.top) > 1 || Math.abs(currentRect.left - rect.left) > 1) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, unavailable, options.length]);

  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const list = menu.current;
    const row = list.children[active] as HTMLElement | undefined;
    if (!row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (
      row.offsetTop + row.offsetHeight >
      list.scrollTop + list.clientHeight
    )
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [open, active, position]);

  function show(index = Math.max(0, selected)) {
    search.current = { text: "", time: 0 };
    setActive(index);
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    if (option.value !== value) onChange?.(option.value);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open)
        show(
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : Math.max(0, selected),
        );
      else
        setActive((index) =>
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                options.length,
        );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(active);
      else show();
      return;
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const now = Date.now();
      const text =
        (now - search.current.time < 700 ? search.current.text : "") +
        event.key.toLowerCase();
      search.current = { text, time: now };
      const match = options.findIndex((option) =>
        option.label.toLowerCase().startsWith(text),
      );
      if (match >= 0) {
        event.preventDefault();
        if (!open) show(match);
        else setActive(match);
        search.current = { text, time: now };
      }
    }
  }
  return (
    <div className="colormap-field">
      <span id={`${id}-label`} className="colormap-label">
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className="colormap-trigger"
        style={widthStyle}
        aria-labelledby={`${id}-label`}
        aria-describedby={range ? `${id}-range` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        disabled={unavailable}
        title={current?.label || value}
        onKeyDown={keyDown}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span
          className="colormap-swatch"
          aria-hidden="true"
          style={{
            backgroundImage: colormapGradient(current?.colors || [], reverse),
          }}
        />
        <span className="colormap-name">{current?.label || value}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {range && (
        <small id={`${id}-range`} className="colormap-range">
          {range}
        </small>
      )}
      {open &&
        !unavailable &&
        createPortal(
          <div
            ref={menu}
            id={`${id}-menu`}
            role="listbox"
            aria-labelledby={`${id}-label`}
            className="colormap-menu"
            style={position}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={`colormap-option${active === index ? " is-active" : ""}`}
                title={option.label}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span
                  className="colormap-swatch"
                  aria-hidden="true"
                  style={{
                    backgroundImage: colormapGradient(option.colors, reverse),
                  }}
                />
                <span className="colormap-name">{option.label}</span>
                {option.value === value ? (
                  <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
