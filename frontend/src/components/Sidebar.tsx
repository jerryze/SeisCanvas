import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export default function Sidebar({
  scope,
  switcher,
  children,
}: {
  scope: string;
  switcher: ReactNode;
  children: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const [moreBelow, setMoreBelow] = useState(false);

  useLayoutEffect(() => {
    const viewport = scroll.current!;
    const desired = positions.current.get(scope) ?? 0;
    let restoring = true;
    const measure = () => {
      if (restoring) viewport.scrollTop = desired;
      setMoreBelow(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2,
      );
    };
    const onScroll = () => {
      if (!restoring) positions.current.set(scope, viewport.scrollTop);
      measure();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content.current!);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    measure();
    // Portalled map controls can finish mounting after this layout effect.
    let frame = requestAnimationFrame(() => {
      measure();
      frame = requestAnimationFrame(() => {
        measure();
        restoring = false;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [scope]);

  return (
    <aside className="sidebar" aria-label="视图与显示设置">
      <div className="sidebar-view-switch">{switcher}</div>
      <div
        className="sidebar-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="侧栏设置，内容可滚动"
      >
        <div className="sidebar-content" ref={content}>
          {children}
        </div>
      </div>
      <div
        className={`sidebar-scroll-hint${moreBelow ? " is-visible" : ""}`}
        aria-hidden="true"
      >
        <ChevronDown size={14} />
      </div>
    </aside>
  );
}
