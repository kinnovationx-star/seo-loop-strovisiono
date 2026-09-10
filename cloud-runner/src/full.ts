// Single-URL deployment: the SEO Loop dashboard and the cloud job runner.
// The dashboard is built by vinext into dist/server; the runner remains the
// only handler for Queue, cron, GPT Image and Claude/Ubersuggest endpoints.
import dashboard from "../../dist/server/index.js";
import runner from "./index";

const runnerPaths = new Set(["/enqueue", "/images", "/oauth/google/config"]);

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (runnerPaths.has(path)) return runner.fetch(request, env, ctx);
    if (path === "/_vinext/image" && !env.IMAGES)
      return new Response("Image optimization is not enabled in this no-R2 deployment.", { status: 404 });
    // Browser traffic receives no owner header. PUBLIC_NO_LOGIN, when
    // explicitly enabled, resolves its single owner inside the dashboard from
    // Worker configuration rather than any browser-controlled value.
    return dashboard.fetch(request, env, ctx);
  },
  queue(batch: MessageBatch<{ jobId: string }>, env: any, ctx: ExecutionContext) {
    return runner.queue(batch, env);
  },
  scheduled(controller: ScheduledController, env: any, ctx: ExecutionContext) {
    return runner.scheduled(controller, env, ctx);
  },
};
