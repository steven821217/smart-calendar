import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * 密碼輸入框，附「顯示／隱藏」切換。
 *
 * 讓使用者能確認自己打了什麼（尤其手機鍵盤或大小寫切換容易出錯）。
 *
 * 幾個刻意的細節：
 *  - 切換鈕是 type="button"：否則在表單內按下去會直接送出表單。
 *  - aria-label 隨狀態改變，並用 aria-pressed 表達切換狀態，螢幕閱讀器才知道現況。
 *  - 切換鈕 tabIndex={-1}：用 Tab 從密碼欄應直接到下一個欄位／送出鈕，
 *    不要卡在這顆裝飾性按鈕上（滑鼠與螢幕閱讀器仍可操作）。
 *  - 預設隱藏，且每次重新掛載都回到隱藏狀態，不會把上次的顯示狀態留下來。
 */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-9", className)}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "隱藏密碼" : "顯示密碼"}
          aria-pressed={visible}
          disabled={props.disabled}
          className={cn(
            "absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md",
            "text-muted-foreground transition-colors hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {visible ? (
            <EyeOff className="h-4 w-4" aria-hidden />
          ) : (
            <Eye className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
