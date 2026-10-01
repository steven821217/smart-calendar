import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { originAllowed } from "../src/mcp/http.js";

/**
 * DNS rebinding 防護（MCP 傳輸規範建議）。
 *
 * 服務一旦不再只綁 loopback（讓同一內網的其他機器連線），就該擋掉來自非預期網頁的請求。
 *
 * 兩邊都要釘死：
 *  - 非瀏覽器的 MCP client 不帶 Origin，**不可**被擋（否則外部 agent 全部連不上）
 *  - 帶了不在允許清單內的 Origin，**必須**擋掉
 */

// originAllowed 每次呼叫才讀環境變數，所以直接改 env 即可，不需重載模組。

const ORIGINAL = process.env.MCP_ALLOWED_ORIGINS;
beforeEach(() => {
  delete process.env.MCP_ALLOWED_ORIGINS;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MCP_ALLOWED_ORIGINS;
  else process.env.MCP_ALLOWED_ORIGINS = ORIGINAL;
});

describe("MCP Origin 防護", () => {
  it("未設定清單時只允許 localhost 系列", () => {
    const allowed = originAllowed;
    expect(allowed("https://localhost:9443")).toBe(true);
    expect(allowed("https://127.0.0.1:9443")).toBe(true);
    expect(allowed("http://localhost:5173")).toBe(true);
    expect(allowed("https://evil.example.com")).toBe(false);
    // 內網 IP 未列入清單時不應自動放行
    expect(allowed("https://192.168.110.143:9443")).toBe(false);
  });

  it("設定清單後只放行清單內的來源（含埠號比對）", () => {
    process.env.MCP_ALLOWED_ORIGINS = "https://192.168.110.143:9443,https://localhost:9443";
    const allowed = originAllowed;
    expect(allowed("https://192.168.110.143:9443")).toBe(true);
    expect(allowed("https://localhost:9443")).toBe(true);
    // 埠號不同視為不同來源
    expect(allowed("https://192.168.110.143:8443")).toBe(false);
    expect(allowed("https://evil.example.com")).toBe(false);
  });

  it("萬用字元可全開（明確選擇時才生效）", () => {
    process.env.MCP_ALLOWED_ORIGINS = "*";
    const allowed = originAllowed;
    expect(allowed("https://anything.example.com")).toBe(true);
  });

  it("格式錯誤的 Origin 一律拒絕", () => {
    const allowed = originAllowed;
    expect(allowed("not-a-url")).toBe(false);
    expect(allowed("")).toBe(false);
  });
});
