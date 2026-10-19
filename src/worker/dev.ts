import { Hono } from "hono";
import { withMcp } from "../mcp/index.ts";
import { api } from "./api";
import worker from "./index";
import type { ApiVariables } from "./api/context.ts";

// Only wrangler.dev.jsonc selects this entrypoint. Production has no auth bypass.
// MCP consent at /authorize still requires Access, so it is unavailable locally.
const app = new Hono<{ Bindings: Env; Variables: ApiVariables }>();
app.use("/api/*", async (c, next) => {
  c.set("accessIdentity", { email: "shuren6699@gmail.com", sub: "local-development" });
  await next();
});
app.route("/api", api);

export default { ...worker, fetch: withMcp(app) };
