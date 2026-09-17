import { useMutation, type UseMutationOptions } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";

/**
 * 統一的 mutation 回饋包裝（9.7, UI-23）：
 *  - pending：呼叫端用回傳的 isPending 顯示 spinner / disable。
 *  - 成功：success toast（可自訂）。
 *  - 失敗：error toast（ApiError 取 detail/title）；409 可帶 action（查看建議時段）。
 *  - 樂觀更新/回滾仍由呼叫端在 onMutate/onError（透過 hooks 參數）提供。
 *
 * 這是薄包裝，不吃掉 TanStack 的 onMutate/onError/onSettled — 會併行呼叫。
 */
export interface FeedbackOptions<TData, TVars, TCtx> {
  successMessage?: string | ((data: TData, vars: TVars) => string);
  /** 回傳 false 表示已自行處理錯誤 toast（例如 409 客製）。 */
  onErrorToast?: (err: unknown, vars: TVars) => boolean | void;
  mutation: UseMutationOptions<TData, unknown, TVars, TCtx>;
}

export function useMutationWithFeedback<TData, TVars, TCtx = unknown>(
  opts: FeedbackOptions<TData, TVars, TCtx>,
) {
  const { successMessage, onErrorToast, mutation } = opts;
  return useMutation<TData, unknown, TVars, TCtx>({
    ...mutation,
    onSuccess: (...args) => {
      (mutation.onSuccess as ((...a: unknown[]) => void) | undefined)?.(...args);
      const data = args[0] as TData;
      const vars = args[1] as TVars;
      if (successMessage) {
        toast.success(
          typeof successMessage === "function" ? successMessage(data, vars) : successMessage,
        );
      }
    },
    onError: (...args) => {
      (mutation.onError as ((...a: unknown[]) => void) | undefined)?.(...args);
      const err = args[0] as unknown;
      const vars = args[1] as TVars;
      const handled = onErrorToast?.(err, vars);
      if (handled === false) return; // 呼叫端已處理
      const msg = err instanceof ApiError ? (err.detail ?? err.title) : "操作失敗，請稍後再試";
      toast.error(msg);
    },
  });
}
