import { describe, it, expect, beforeAll } from "vitest";
import pg from "pg";
import type { z } from "zod";
import type { AuthContext } from "../src/auth/jwt.js";
import type { ChatModel, ChatMessage } from "../src/agents/llm.js";
import { toolDelegateComplexScheduling } from "../src/mcp/tools.js";
import { signOptionToken, verifyOptionToken, OptionTokenError } from "../src/agents/option_token.js";

function adminClient() {
  return new pg.Client({
    connectionString:
      process.env.ADMIN_DATABASE_URL ??
      `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? "change-me-postgres"}@localhost:5432/${process.env.DB_NAME ?? "calendar"}`,
  });
}

let WS: string, WS_B: string, CAL: string, MEM: string, MEM2: string, VEHICLE: string;
const BOB_NAME = "Bob Ext";

beforeAll(async () => {
  const admin = adminClient();
  await admin.connect();
  WS = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-a'`)).rows[0].id;
  WS_B = (await admin.query(`SELECT id FROM workspaces WHERE slug='ws-b'`)).rows[0].id;
  CAL = (await admin.query(`SELECT id FROM calendars WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, [WS])).rows[0].id;
  MEM = (await admin.query(`SELECT id FROM memberships WHERE workspace_id=$1 LIMIT 1`, [WS])).rows[0].id;
  const bobUser = (
    await admin.query(
      `INSERT INTO users(email,display_name) VALUES('bob-ext@example.com',$1)
       ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
      [BOB_NAME],
    )
  ).rows[0].id;
  MEM2 = (
    await admin.query(
      `INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'member')
       ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='member' RETURNING id`,
      [WS, bobUser],
    )
  ).rows[0].id;
  await admin.query(`DELETE FROM resource_bookings WHERE workspace_id=$1`, [WS]);
  await admin.query(`DELETE FROM resources WHERE workspace_id=$1 AND name LIKE '%公務車%'`, [WS]);
  await admin.query(`DELETE FROM events WHERE workspace_id=$1 AND start_utc >= '2027-01-01'`, [WS]);
  VEHICLE = (
    await admin.query(
      `INSERT INTO resources(workspace_id,name,type) VALUES($1,'ExtVehicle-公務車','equipment') RETURNING id`,
      [WS],
    )
  ).rows[0].id;
  await admin.end();
});

const agentAuth = (over: Partial<AuthContext> = {}): AuthContext => ({
  sub: MEM,
  workspace: WS,
  roles: ["scheduler"],
  scope: ["availability.read", "event.write", "resource.book"],
  ...over,
});

function bobVehicleModel(): ChatModel {
  return {
    async invokeStructured<T>(_s: z.ZodType<T>, _m: ChatMessage[]): Promise<T> {
      return { attendee_ids: [MEM2], unresolved_names: [], resources: [{ kind: "vehicle" }] } as T;
    },
  };
}

describe("延伸 C：option_token 簽章/驗章 (X.1)", () => {
  const claims = {
    workspace: "will-be-set",
    calendar_id: "cal",
    attendees: ["m1"],
    resource_id: "res",
    needs_handover: true,
    actual_start_utc: "2027-10-01T06:00:00Z",
    actual_end_utc: "2027-10-01T07:00:00Z",
    booking_start_utc: "2027-10-01T05:45:00Z",
    booking_end_utc: "2027-10-01T07:15:00Z",
    title: "t",
    timezone: "UTC",
  };

  it("正確簽章可驗回原 claims", () => {
    const c = { ...claims, workspace: WS };
    const tok = signOptionToken(c);
    const back = verifyOptionToken(tok, WS);
    expect(back.resource_id).toBe("res");
    expect(back.booking_start_utc).toBe("2027-10-01T05:45:00Z");
  });

  it("跨 workspace 使用 → OptionTokenError（ZT-5）", () => {
    const tok = signOptionToken({ ...claims, workspace: WS });
    expect(() => verifyOptionToken(tok, WS_B)).toThrow(OptionTokenError);
  });

  it("竄改內容 → 驗章失敗", () => {
    const tok = signOptionToken({ ...claims, workspace: WS });
    const [p] = tok.split(".");
    const tampered = `${p}x.${tok.split(".")[1]}`;
    expect(() => verifyOptionToken(tampered, WS)).toThrow(OptionTokenError);
  });

  it("過期 → 驗章失敗", () => {
    const tok = signOptionToken({ ...claims, workspace: WS }, -1);
    expect(() => verifyOptionToken(tok, WS)).toThrow(/expired/);
  });
});

describe("延伸 C：一鍵確認落實 (X.1 端到端)", () => {
  it("confirm=false 回 option_token；confirm=true+token 直接落實（免重跑圖）", async () => {
    const preview = await toolDelegateComplexScheduling(
      agentAuth(),
      {
        task_description: `跟 ${BOB_NAME} 借公務車 2027-10-02 下午 2 點`,
        reference_now_utc: "2026-09-15T00:00:00Z",
        default_timezone: "UTC",
        confirm: false,
        calendar_id: CAL,
        title: "拜訪",
      },
      { model: bobVehicleModel() },
    );
    expect(preview.status).toBe("needs_decision");
    expect(typeof preview.option_token).toBe("string");

    // 一鍵確認：不再提供 model（證明未重跑圖/未呼叫 LLM）
    const booked = await toolDelegateComplexScheduling(agentAuth(), {
      task_description: "irrelevant now",
      confirm: true,
      option_token: preview.option_token,
    });
    expect(booked.status).toBe("booked");
    const result = booked.result as { booking: { resource_id: string }; reminders: unknown[] };
    // 落實的資源是某台公務車（equipment 且名稱含公務車關鍵字）
    const admin = adminClient();
    await admin.connect();
    const res = await admin.query(
      `SELECT type, name FROM resources WHERE workspace_id=$1 AND id=$2`,
      [WS, result.booking.resource_id],
    );
    await admin.end();
    expect(res.rows[0].type).toBe("equipment");
    expect(String(res.rows[0].name)).toContain("公務車");
    expect(result.reminders.length).toBe(1); // 公務車提醒仍自動掛
  });
});

describe("延伸 E：needs_decision webhook enum (X.2)", () => {
  it("WebhookInput 接受 scheduling.needs_decision", async () => {
    const { WebhookInput } = await import("@scal/shared");
    const parsed = WebhookInput.safeParse({ url: "https://example.com/hook", events: ["scheduling.needs_decision"] });
    expect(parsed.success).toBe(true);
  });
});
