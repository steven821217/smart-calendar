import type { ChatMessage } from "./llm.js";
import type { MemberRow } from "./service.js";

/**
 * 三節點 prompt（B.1）。
 * Coordinator 只抽 attendees/resources 實體（時間交給既有 parseEventFromText）。
 * prompt 內不夾帶 workspace/sub，也不接受 NL 覆寫（ZT-5）；名字比對以 memberDirectory 為準。
 */

export function coordinatorMessages(
  taskDescription: string,
  memberDirectory: MemberRow[],
): ChatMessage[] {
  const roster = memberDirectory
    .map((m) => `- ${m.display_name} (id=${m.membership_id})`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You are the Coordinator of an internal scheduling committee. " +
        "Extract the event title, the people the user explicitly named, and resource needs. " +
        "Do NOT infer dates or times (handled elsewhere).\n" +
        // event_title：先前沒有這個欄位，事件標題被塞成整句（「幫我安排今天晚上9：00打球」）。
        "event_title: what the event IS, as a short noun phrase in the user's language. " +
        "Strip politeness and scheduling verbs (幫我/請/安排/訂) and all time words. " +
        "Examples: 『幫我安排今天晚上9:00打球』→『打球』；『明天下午跟林小明開會』→『開會』.\n" +
        // person_mentions：與 attendee_ids 分離，讓「活動名稱」不會被當成人名。
        "person_mentions: the display NAMES (not ids) of other people the user explicitly asked to include. " +
        "Use [] when the user named nobody. Activities, places, resources, and generic roles " +
        "(客戶/廠商/客人) are NOT people. Never include the requester themselves.\n" +
        "attendee_ids: roster ids matching person_mentions, one id per matched name. " +
        "If person_mentions is empty, attendee_ids MUST be empty too — a personal event with no " +
        "attendees is normal. Never invite the whole roster and never invent ids.\n" +
        "unresolved_names: named people with no unique roster match.\n" +
        "Resource kinds: 'vehicle' (公務車/car), 'room', 'equipment', or 'named'.\n\nRoster:\n" +
        (roster || "(no members)"),
    },
    { role: "human", content: taskDescription },
  ];
}
