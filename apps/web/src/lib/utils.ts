import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** cn() = clsx + tailwind-merge（frontend.md §6）。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
