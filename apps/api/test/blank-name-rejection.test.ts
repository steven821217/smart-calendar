import { describe, it, expect } from "vitest";
import { EventInput, RegisterInput, ResourceInput, CreateWorkspaceInput, nonBlankText } from "@scal/shared";

/**
 * 純空白的名稱／標題必須被驗證層擋掉。
 *
 * 起因：`z.string().min(1)` 驗的是未 trim 的原字串，所以 "   " 長度 3 會通過，
 * 等到 handler 才 trim 成空字串 → 建出無名的 workspace／事件／群組。
 * 實測確認過：帶 workspace_name="   " 註冊會回 201 並產生名稱為 "   " 的 workspace。
 */

const BLANK = ["   ", "\t", "\n", " \u3000 "]; // 含全形空白

describe("純空白名稱一律拒絕", () => {
  it("nonBlankText 擋掉各種空白，並對合法值 trim", () => {
    const s = nonBlankText(10, "名稱");
    for (const b of BLANK) expect(s.safeParse(b).success, JSON.stringify(b)).toBe(false);
    expect(s.parse("  有名字  ")).toBe("有名字");
    expect(s.safeParse("12345678901").success).toBe(false); // 超長
  });

  it("註冊：display_name / workspace_name 純空白 → 不通過", () => {
    const base = { email: "x@example.com", password: "long-enough-pass", timezone: "Asia/Taipei" };
    expect(RegisterInput.safeParse({ ...base, display_name: "   ", workspace_name: "公司" }).success).toBe(false);
    expect(RegisterInput.safeParse({ ...base, display_name: "小明", workspace_name: "   " }).success).toBe(false);
    // 合法值會被 trim
    const ok = RegisterInput.parse({ ...base, display_name: " 小明 ", workspace_name: " 公司 " });
    expect(ok.display_name).toBe("小明");
    expect(ok.workspace_name).toBe("公司");
  });

  it("建立工作區 / 事件 / 資源：純空白名稱 → 不通過", () => {
    expect(CreateWorkspaceInput.safeParse({ name: "   " }).success).toBe(false);
    expect(ResourceInput.safeParse({ name: "   ", type: "room" }).success).toBe(false);
    expect(
      EventInput.safeParse({
        calendar_id: "00000000-0000-4000-8000-000000000000",
        title: "   ",
        start_utc: "2026-01-01T00:00:00.000Z",
        end_utc: "2026-01-01T01:00:00.000Z",
        timezone: "Asia/Taipei",
      }).success,
    ).toBe(false);
  });
});
