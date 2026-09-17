import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt } from "../src/auth/jwt.js";
import { authorize } from "../src/auth/pdp.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "22222222-2222-2222-2222-222222222222";
const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("JWT (AuthN)", () => {
  it("簽發後可驗回，且 workspace/roles 保留", () => {
    const t = signJwt({ sub: USER, workspace: WS, roles: ["member"] });
    const ctx = verifyJwt(`Bearer ${t}`);
    expect(ctx?.sub).toBe(USER);
    expect(ctx?.workspace).toBe(WS);
    expect(ctx?.roles).toContain("member");
  });
  it("竄改簽章 → 驗證失敗", () => {
    const t = signJwt({ sub: USER, workspace: WS, roles: ["admin"] });
    expect(verifyJwt(`Bearer ${t}x`)).toBeNull();
  });
  it("過期 token → 驗證失敗", () => {
    const t = signJwt({ sub: USER, workspace: WS, roles: ["admin"] }, -1);
    expect(verifyJwt(`Bearer ${t}`)).toBeNull();
  });
});

describe("PDP (OPA) 授權決策", () => {
  const sub = { sub: USER, workspace: WS, roles: ["member"] };

  it("member 可在自己 workspace 建立事件", async () => {
    const d = await authorize({
      subject: sub,
      action: "event.create",
      resource: { type: "event", workspace: WS },
    });
    expect(d.allow).toBe(true);
  });

  it("member 不可管理 agent（僅 admin）", async () => {
    const d = await authorize({
      subject: sub,
      action: "agent.manage",
      resource: { type: "agent", workspace: WS },
    });
    expect(d.allow).toBe(false);
  });

  it("admin 可管理 agent（本 workspace）", async () => {
    const d = await authorize({
      subject: { sub: USER, workspace: WS, roles: ["admin"] },
      action: "agent.manage",
      resource: { type: "agent", workspace: WS },
    });
    expect(d.allow).toBe(true);
  });

  it("跨 workspace resource → deny（PDP 層）", async () => {
    const d = await authorize({
      subject: sub,
      action: "event.create",
      resource: { type: "event", workspace: OTHER_WS },
    });
    expect(d.allow).toBe(false);
  });

  it("本人可改自己建立的事件", async () => {
    const d = await authorize({
      subject: sub,
      action: "event.update",
      resource: { type: "event", workspace: WS, owner_id: USER },
    });
    expect(d.allow).toBe(true);
  });

  it("member 不可改他人事件（private）", async () => {
    const d = await authorize({
      subject: sub,
      action: "event.update",
      resource: { type: "event", workspace: WS, owner_id: "other", visibility: "private" },
    });
    expect(d.allow).toBe(false);
  });
});
