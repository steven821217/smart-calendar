import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Users, Check, Clock, X, Mail } from "lucide-react";
import { api, ApiError, type EventParticipant } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/feedback";

/**
 * 與會者選擇與狀態顯示。
 *
 * 語意（與 agent 排程路徑一致）：
 *  - 發起人自己一律在名單內且為已接受，不出現在可勾選清單（不能把自己移除）。
 *  - 勾選的其他成員為「已邀請待回覆」（pending）——對方同意後才算排入他的行程，
 *    他會在右上鈴鐺的待回覆清單看到這場會。
 *  - 已經回覆過的人再次編輯事件時不會被重設狀態。
 *
 * 範圍切換：成員多時逐一找人很慢，所以提供「全部成員 / 各團隊群組 / 未分組」切換。
 * 切換只影響**顯示哪些人**，不會動到已勾選的名單——否則切一下分類就把選好的人清掉了。
 */

const STATUS_LABEL: Record<string, { text: string; className: string; Icon: typeof Check }> = {
  accepted: { text: "已接受", className: "text-emerald-600", Icon: Check },
  pending: { text: "待回覆", className: "text-amber-600", Icon: Clock },
  declined: { text: "已婉拒", className: "text-muted-foreground", Icon: X },
};

export function ParticipantStatusList({ participants }: { participants: EventParticipant[] }) {
  if (participants.length === 0) {
    return <p className="text-xs text-muted-foreground">目前只有你自己。</p>;
  }
  return (
    <ul className="space-y-1">
      {participants.map((p) => {
        const s = STATUS_LABEL[p.rsvp_status] ?? {
          text: p.rsvp_status,
          className: "text-muted-foreground",
          Icon: Clock,
        };
        const name = p.display_name ?? p.guest_email ?? p.email ?? "（未知）";
        return (
          <li
            key={p.member_id ?? p.guest_email ?? name}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="truncate">
              {name}
              {p.is_organizer && (
                <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-xs">發起人</span>
              )}
            </span>
            <span className={`flex shrink-0 items-center gap-1 text-xs ${s.className}`}>
              <s.Icon className="h-3.5 w-3.5" aria-hidden />
              {s.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** 特殊範圍值，與群組 id（uuid）不會相撞。 */
const SCOPE_ALL = "__all__";
const SCOPE_UNGROUPED = "__ungrouped__";

interface Props {
  /** 已勾選的 membership_id（不含自己）。 */
  selected: string[];
  onChange: (memberIds: string[]) => void;

  /** 編輯既有事件時傳入，用來顯示每個人的回覆狀態。 */
  existing?: EventParticipant[];
  disabled?: boolean;
}

export function AttendeePicker({ selected, onChange, existing, disabled }: Props) {
  const me = useAuth((s) => s.me);
  const [scope, setScope] = useState<string>(SCOPE_ALL);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  /** 以 email 找到並加入的人，用來顯示「已用 email 加入：王大文」。 */
  const [emailAdded, setEmailAdded] = useState<Array<{ membership_id: string; display_name: string }>>([]);

  const membersQ = useQuery({
    queryKey: ["workspace-members", me?.workspace.id],
    queryFn: () => api.listWorkspaceMembers(),
    enabled: !!me,
    staleTime: 60_000,
  });
  const groupsQ = useQuery({
    queryKey: ["groups", me?.workspace.id],
    queryFn: () => api.listGroups(),
    enabled: !!me,
    staleTime: 60_000,
  });
  const groups = groupsQ.data?.groups ?? [];

  // 各群組的成員：算「未分組」需要全部群組的名單，所以一次全取（群組數量少，且有快取）
  const groupMemberQs = useQueries({
    queries: groups.map((g) => ({
      queryKey: ["group-members", g.id],
      queryFn: () => api.listGroupMembers(g.id),
      staleTime: 60_000,
    })),
  });

  /** group id → 該群組的 membership_id 集合 */
  const membershipsByGroup = useMemo(() => {
    const map = new Map<string, Set<string>>();
    groups.forEach((g, i) => {
      const rows = groupMemberQs[i]?.data?.members ?? [];
      map.set(
        g.id,
        new Set(rows.map((r) => r.membership_id).filter((x): x is string => !!x)),
      );
    });
    return map;
  }, [groups, groupMemberQs.map((q) => q.dataUpdatedAt).join(",")]);

  const groupedMemberships = useMemo(() => {
    const all = new Set<string>();
    for (const set of membershipsByGroup.values()) for (const id of set) all.add(id);
    return all;
  }, [membershipsByGroup]);

  // 自己不列入可勾選清單：發起人不能把自己移除
  const others = useMemo(
    () => (membersQ.data?.members ?? []).filter((m) => m.membership_id !== me?.membership_id),
    [membersQ.data, me?.membership_id],
  );

  const visible = useMemo(() => {
    if (scope === SCOPE_ALL) return others;
    if (scope === SCOPE_UNGROUPED) return others.filter((m) => !groupedMemberships.has(m.membership_id));
    const set = membershipsByGroup.get(scope);
    return set ? others.filter((m) => set.has(m.membership_id)) : [];
  }, [scope, others, groupedMemberships, membershipsByGroup]);

  const statusOf = new Map((existing ?? []).map((p) => [p.member_id, p.rsvp_status]));

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  /** 全選／取消全選目前顯示的人（不影響未顯示的既有勾選）。 */
  const visibleIds = visible.map((m) => m.membership_id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  const toggleAllVisible = () => {
    onChange(
      allVisibleSelected
        ? selected.filter((id) => !visibleIds.includes(id))
        : [...new Set([...selected, ...visibleIds])],
    );
  };

  /**
   * 以 email 找人並直接加入勾選名單。
   *
   * 平台上的人都以 email 註冊，所以 email 一定找得到人——找不到就是打錯字或對方
   * 還沒加入這個工作區。此時當場報錯，不要留下一筆沒人看得到的紀錄。
   * 比對在後端做：前端拿不到（也不該拿到）全體成員的 email 清單。
   */
  const addByEmail = async () => {
    const raw = emailDraft.trim();
    if (!raw || emailBusy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      setEmailErr("請輸入有效的 email");
      return;
    }
    setEmailBusy(true);
    setEmailErr(null);
    try {
      const { member } = await api.findMemberByEmail(raw);
      if (member.membership_id === me?.membership_id) {
        setEmailErr("這是你自己，你已經是發起人。");
        return;
      }
      if (!selected.includes(member.membership_id)) {
        onChange([...selected, member.membership_id]);
      }
      setEmailAdded((prev) =>
        prev.some((x) => x.membership_id === member.membership_id)
          ? prev
          : [...prev, { membership_id: member.membership_id, display_name: member.display_name }],
      );
      setEmailDraft("");
    } catch (e) {
      setEmailErr(e instanceof ApiError ? (e.detail ?? e.title) : "查詢失敗");
    } finally {
      setEmailBusy(false);
    }
  };

  const selectedCount = selected.length;

  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="flex items-center gap-1.5 text-sm font-medium">
        <Users className="h-3.5 w-3.5" aria-hidden />
        邀請與會者
        {selectedCount > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal">
            已選 {selectedCount} 人
          </span>
        )}
      </legend>

      <div className="flex items-center gap-1.5">
        <select
          aria-label="與會者範圍"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value={SCOPE_ALL}>全部成員（{others.length}）</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}（{membershipsByGroup.get(g.id)?.size ?? 0}）
            </option>
          ))}
          <option value={SCOPE_UNGROUPED}>
            未分組（{others.filter((m) => !groupedMemberships.has(m.membership_id)).length}）
          </option>
        </select>
        {visible.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 bg-background text-xs"
            onClick={toggleAllVisible}
          >
            {allVisibleSelected ? "取消全選" : "全選"}
          </Button>
        )}
      </div>

      {membersQ.isLoading ? (
        <p className="text-xs text-muted-foreground">載入成員…</p>
      ) : others.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          這個工作區目前只有你。可到「團隊群組」頁把成員加進工作區。
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-md border border-input px-2 py-3 text-center text-xs text-muted-foreground">
          {scope === SCOPE_UNGROUPED ? "所有成員都已分到群組。" : "這個群組目前沒有成員。"}
        </p>
      ) : (
        <div className="max-h-36 space-y-1 overflow-auto rounded-md border border-input p-2">
          {visible.map((m) => {
            const status = statusOf.get(m.membership_id);
            const s = status ? STATUS_LABEL[status] : undefined;
            return (
              <label key={m.membership_id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(m.membership_id)}
                  onChange={() => toggle(m.membership_id)}
                  className="h-4 w-4 rounded border-input"
                />
                <span className="truncate">{m.display_name}</span>
                {s && (
                  <span className={`ml-auto flex shrink-0 items-center gap-1 text-xs ${s.className}`}>
                    <s.Icon className="h-3 w-3" aria-hidden />
                    {s.text}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
      <div className="space-y-1.5 rounded-md border border-input p-2">
        <label className="flex items-center gap-1.5 text-xs font-medium" htmlFor="ev-guest-email">
          <Mail className="h-3 w-3" aria-hidden />
          用 email 找人
        </label>
        <div className="flex gap-1.5">
          <Input
            id="ev-guest-email"
            type="email"
            value={emailDraft}
            onChange={(e) => {
              setEmailDraft(e.target.value);
              setEmailErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault(); // 不要觸發整張表單送出
                void addByEmail();
              }
            }}
            placeholder="name@example.com"
            className="h-8 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 bg-background text-xs"
            disabled={!emailDraft.trim() || emailBusy}
            onClick={() => void addByEmail()}
          >
            {emailBusy ? <Spinner /> : "加入"}
          </Button>
        </div>
        {emailErr && <p className="text-xs text-destructive">{emailErr}</p>}
        {emailAdded.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {emailAdded
              .filter((x) => selected.includes(x.membership_id))
              .map((x) => (
                <li
                  key={x.membership_id}
                  className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 ring-1 ring-inset ring-emerald-500/20"
                >
                  <Check className="h-3 w-3" aria-hidden />
                  {x.display_name}
                </li>
              ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          找到的人會自動勾選到上方名單。若查無此人，表示對方還沒加入這個工作區。
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        被邀請的人會收到待回覆邀請（右上鈴鐺），同意後才排進他的行程。
      </p>
    </fieldset>
  );
}
