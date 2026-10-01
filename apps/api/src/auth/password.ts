import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * 密碼雜湊（3.1 正式化）。
 *
 * 選 scrypt 而非 bcrypt/argon2：Node 內建 `node:crypto` 就有，**不需新增依賴**
 *（避免原生編譯與供應鏈風險），且是記憶體困難（memory-hard）演算法，對 GPU 暴力破解
 * 有實質阻力。參數寫進雜湊字串，日後可調高而不影響舊密碼驗證（自帶版本資訊）。
 *
 * 儲存格式（單一 text 欄位，自描述）：
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 */

/** 預設成本：N=2^15 → 記憶體約 128*N*r = 32MB，登入延遲約數十毫秒等級。 */
const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
/** maxmem 需 > 128*N*r，否則 Node 會丟 error。 */
const MAXMEM = 128 * N * R * 2;

/** 密碼長度下限（避免過短密碼；上限防 DoS——過長輸入不該讓 KDF 無限工作）。 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** 產生 `password_hash` 欄位要存的字串。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * 驗證密碼。任何格式異常/未設密碼一律回 false（fail-closed），不拋例外，
 * 讓呼叫端只回通用 401、不洩漏帳號是否存在或是否已設密碼。
 */
export async function verifyPassword(password: string, stored?: string | null): Promise<boolean> {
  if (!stored || !password) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const actual = await scrypt(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
    // 定長比較，防 timing attack
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
