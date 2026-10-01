import type { FastifyInstance } from "fastify";
import { enforce } from "../auth/pep.js";
import { withWorkspace } from "../db/pool.js";

/**
 * 行事曆端點（api.md 9）。
 *
 * 個人隔離：只回**本人擁有**的行事曆。工作區裡有其他成員時，列出全部人的行事曆
 * 會讓 member 知道 leader 有哪些日曆，也讓前端容易誤把事件建到別人的日曆上
 *（建立事件的 calendar_id 由此清單提供）。RLS 仍兜底 workspace 邊界。
 */
export function registerCalendarRoutes(app: FastifyInstance) {
  app.get("/v1/calendars", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "calendar.read", { type: "calendar", workspace: auth.workspace })))
      return;
    const calendars = await withWorkspace(auth.workspace, async (c) => {
      const r = await c.query(
        `SELECT id, name, owner_id FROM calendars WHERE owner_id = $1 ORDER BY name`,
        [auth.sub],
      );
      return r.rows;
    });
    return { calendars };
  });
}
