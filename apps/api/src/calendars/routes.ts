import type { FastifyInstance } from "fastify";
import { enforce } from "../auth/pep.js";
import { withWorkspace } from "../db/pool.js";

/** 行事曆端點（api.md 9）。列本 workspace 行事曆（RLS 兜底）。 */
export function registerCalendarRoutes(app: FastifyInstance) {
  app.get("/v1/calendars", async (req, reply) => {
    const auth = req.auth!;
    if (!(await enforce(req, reply, "calendar.read", { type: "calendar", workspace: auth.workspace })))
      return;
    const calendars = await withWorkspace(auth.workspace, async (c) => {
      const r = await c.query(
        `SELECT id, name, owner_id FROM calendars ORDER BY name`,
      );
      return r.rows;
    });
    return { calendars };
  });
}
