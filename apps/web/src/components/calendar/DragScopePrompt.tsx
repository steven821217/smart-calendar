import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Scope } from "@/components/calendar/EventDialog";

/** 拖曳重複事件落定時的 scope 選擇（UI-21：重複先選 scope）。 */
export function DragScopePrompt({
  onPick,
  onCancel,
}: {
  onPick: (scope: Scope) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState<Scope>("this");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="選擇套用範圍"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-xs space-y-4 rounded-lg border border-border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">改期套用範圍</h2>
        <div className="flex flex-col gap-1.5">
          {(
            [
              ["this", "僅這一次"],
              ["this_and_future", "這次及之後"],
              ["all", "所有場次"],
            ] as [Scope, string][]
          ).map(([val, label]) => (
            <label key={val} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="drag-scope"
                checked={scope === val}
                onChange={() => setScope(val)}
              />
              {label}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" onClick={() => onPick(scope)}>
            確定
          </Button>
        </div>
      </div>
    </div>
  );
}
