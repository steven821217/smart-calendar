import type { ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { Occurrence } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 可拖曳的事件晶片。id = occurrence 唯一鍵；data 帶 occ 供 onDragEnd 使用。 */
export function DraggableChip({
  occ,
  className,
  title,
  children,
  style,
  onClick,
}: {
  occ: Occurrence;
  className?: string;
  title?: string;
  children: ReactNode;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const id = `${occ.event_id}::${occ.occurrence_start_utc}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { occ },
  });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      title={title}
      style={style}
      className={cn(className, isDragging && "opacity-40")}
    >
      {children}
    </button>
  );
}

/** 可放置區（日格 / 時段）。isOver 時高亮。 */
export function DroppableCell({
  id,
  className,
  children,
  onClick,
  ariaLabel,
  style,
}: {
  id: string;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
  style?: React.CSSProperties;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      onClick={onClick}
      aria-label={ariaLabel}
      style={style}
      className={cn(className, isOver && "ring-2 ring-inset ring-ring bg-accent/40")}
    >
      {children}
    </div>
  );
}
