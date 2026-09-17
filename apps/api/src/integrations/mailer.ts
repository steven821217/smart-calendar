import net from "node:net";

/**
 * 極簡 SMTP 送信（本機 → MailHog，10.1 / REQ-N1）。
 * 不引入第三方相依（避免更動 lockfile）；MailHog 無需 AUTH/TLS。
 * 僅供本機開發用；正式環境應改用具重試/退避的 provider SDK。
 *
 * 未設定 SMTP_HOST 時回傳 { sent:false, skipped:true } —— 讓無 SMTP 的環境（如 CI 單元測試）
 * 不因缺信箱服務而失敗，同時仍可被上層記錄。
 */

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface SendResult {
  sent: boolean;
  skipped?: boolean;
  reason?: string;
}

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

async function readReply(sock: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      // 最後一行以 "NNN " (非 "NNN-") 收尾即為完整回應
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve(buf);
      }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => {
      sock.off("data", onData);
      sock.off("error", onErr);
    };
    sock.on("data", onData);
    sock.on("error", onErr);
  });
}

async function cmd(sock: net.Socket, line: string, expect: RegExp): Promise<void> {
  sock.write(line + "\r\n");
  const reply = await readReply(sock);
  const code = reply.trim().split(/\r?\n/).pop() ?? "";
  if (!expect.test(code)) throw new Error(`SMTP unexpected reply to "${line}": ${code}`);
}

/** 送出一封純文字信到 MailHog。SMTP 未設定時跳過（skipped:true）。 */
export async function sendMail(msg: MailMessage, timeoutMs = 5000): Promise<SendResult> {
  if (!smtpConfigured()) return { sent: false, skipped: true, reason: "SMTP_HOST unset" };
  const host = process.env.SMTP_HOST!;
  const port = Number(process.env.SMTP_PORT ?? 1025);

  return new Promise<SendResult>((resolve) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    const fail = (reason: string) => {
      try { sock.destroy(); } catch { /* noop */ }
      resolve({ sent: false, reason });
    };
    sock.on("timeout", () => fail("smtp timeout"));
    sock.on("error", (e) => fail(e.message));
    sock.once("connect", async () => {
      try {
        await readReply(sock); // 220 greeting
        await cmd(sock, `EHLO smart-calendar`, /^250/);
        await cmd(sock, `MAIL FROM:<${msg.from}>`, /^250/);
        await cmd(sock, `RCPT TO:<${msg.to}>`, /^250/);
        await cmd(sock, `DATA`, /^354/);
        const body =
          `From: ${msg.from}\r\nTo: ${msg.to}\r\nSubject: ${msg.subject}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n\r\n${msg.text}\r\n.`;
        await cmd(sock, body, /^250/);
        await cmd(sock, `QUIT`, /^221/);
        sock.end();
        resolve({ sent: true });
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    });
  });
}
