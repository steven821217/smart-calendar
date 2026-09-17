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
        "Extract ONLY the attendees and resource needs from the user's task. " +
        "Do NOT infer dates or times (handled elsewhere). " +
        "Match each named attendee to EXACTLY ONE member from the roster by display name; " +
        "if a name has no unique match, leave it out of attendee_ids and add it to unresolved_names. " +
        "Resource kinds: 'vehicle' (公務車/car), 'room', 'equipment', or 'named'. " +
        "Never invent member ids that are not in the roster.\n\nRoster:\n" +
        (roster || "(no members)"),
    },
    { role: "human", content: taskDescription },
  ];
}
