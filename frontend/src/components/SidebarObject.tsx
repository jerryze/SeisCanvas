import { useId, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export default function SidebarObject({
  open,
  selected,
  hidden = false,
  label,
  labelControls,
  title,
  visibility,
  metadata,
  action,
  onToggle,
  children,
}: {
  open: boolean;
  selected: boolean;
  hidden?: boolean;
  label: ReactNode;
  labelControls?: ReactNode;
  title: string;
  visibility: ReactNode;
  metadata?: ReactNode;
  action: ReactNode;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const row = useRef<HTMLDivElement>(null);
  const reveal = () => {
    const element = row.current;
    const viewport = element?.closest<HTMLElement>(".sidebar-scroll");
    if (!element || !viewport) return;
    const bounds = element.getBoundingClientRect();
    const area = viewport.getBoundingClientRect();
    const bottom = Math.min(bounds.bottom, bounds.top + 112);
    if (bounds.top < area.top + 8)
      viewport.scrollTop += bounds.top - area.top - 8;
    else if (bottom > area.bottom - 20)
      viewport.scrollTop += bottom - area.bottom + 20;
  };
  const toggle = (
    <button
      type="button"
      className={`object-toggle${labelControls ? " object-disclosure" : ""}`}
      title={title}
      aria-label={labelControls ? title : undefined}
      aria-expanded={open}
      aria-controls={id}
      onClick={() => {
        onToggle();
        if (!open) requestAnimationFrame(reveal);
      }}
    >
      {!labelControls && <span className="object-label">{label}</span>}
      {metadata}
      <ChevronDown className="object-chevron" size={12} />
    </button>
  );
  return (
    <div
      ref={row}
      className={`sidebar-object${open ? " is-open" : ""}${selected ? " is-selected" : ""}${hidden ? " is-hidden" : ""}`}
    >
      <div className="object-row">
        {visibility}
        {labelControls ? (
          <div className="object-heading">
            {labelControls}
            {toggle}
          </div>
        ) : (
          toggle
        )}
        {action}
      </div>
      <div id={id} className="object-body" hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}
