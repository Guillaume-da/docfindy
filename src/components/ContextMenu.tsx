import { useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  separator?: boolean; // draw a divider above this item
}

// Right-click context menu, glass-styled. Closes on outside press, Escape,
// scroll or window blur. Position is clamped to the viewport after measuring.
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useLayoutEffect(() => {
    function onDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-[210px] rounded-[12px] border border-edge bg-surface p-1.5 shadow-2xl backdrop-blur-2xl fade-in"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separator && i > 0 && (
            <div className="mx-2 my-1 border-t border-edge-soft" />
          )}
          <button
            onClick={() => {
              onClose();
              it.onClick();
            }}
            className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] font-medium text-txt transition hover:bg-row-selected"
          >
            {it.icon && (
              <span className="grid w-4 shrink-0 place-items-center text-muted">
                {it.icon}
              </span>
            )}
            {it.label}
          </button>
        </div>
      ))}
    </div>
  );
}
