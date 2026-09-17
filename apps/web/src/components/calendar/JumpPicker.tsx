import { useEffect, useRef, useState } from "react";
import { setMonth, setYear, getMonth, getYear } from "date-fns";
import { cn } from "@/lib/utils";

/**
 * JumpPicker（UX：快速跳任意月/年）：
 * 點標題展開面板 → 年份左右快速切 + 12 個月份格子；選定即跳。
 * 取代原本只能逐月/逐週 ‹ › 的導航痛點（跳遠期日期需狂點）。
 */
export function JumpPicker({
  anchor,
  onPick,
  className,
}: {
  anchor: Date;
  onPick: (d: Date) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // 面板內暫存的「檢視年份」（尚未套用；選月份才真的跳）
  const [viewYear, setViewYear] = useState(() => getYear(anchor));
  const ref = useRef<HTMLDivElement>(null);

  // 每次開啟時同步到目前 anchor 的年份
  useEffect(() => {
    if (open) setViewYear(getYear(anchor));
  }, [open, anchor]);

  // 點外面 / Esc 關閉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const curMonth = getMonth(anchor);
  const curYear = getYear(anchor);
  const months = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

  const pick = (monthIdx: number) => {
    onPick(setYear(setMonth(anchor, monthIdx), viewYear));
    setOpen(false);
  };

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "rounded-md px-2 py-1 text-sm font-medium tabular-nums transition-colors hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        title="點此快速跳到任意月份 / 年份"
      >
        {curYear} 年 {curMonth + 1} 月
        <span className="ml-1 text-[10px] text-muted-foreground">▾</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="快速跳轉日期"
          className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-popover p-3 shadow-lg"
        >
          {/* 年份切換列：‹ 年 › + 手動輸入 */}
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewYear((y) => y - 1)}
              className="rounded px-2 py-1 text-sm hover:bg-accent"
              aria-label="上一年"
            >
              «
            </button>
            <input
              type="number"
              value={viewYear}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v)) setViewYear(v);
              }}
              className="w-20 rounded border border-border bg-transparent px-2 py-1 text-center text-sm font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="年份"
            />
            <button
              type="button"
              onClick={() => setViewYear((y) => y + 1)}
              className="rounded px-2 py-1 text-sm hover:bg-accent"
              aria-label="下一年"
            >
              »
            </button>
          </div>

          {/* 12 個月份格子 */}
          <div className="grid grid-cols-3 gap-1">
            {months.map((m, i) => {
              const isCurrent = viewYear === curYear && i === curMonth;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => pick(i)}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs transition-colors",
                    isCurrent
                      ? "bg-primary font-medium text-primary-foreground"
                      : "hover:bg-accent",
                  )}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
