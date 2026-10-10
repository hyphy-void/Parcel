import {
  verifyAccess,
  route,
  security,
  problem,
  readBody,
} from "../gateway.mjs";
import { configuration, Service, Problem } from "./service.mjs";
import { equal } from "./crypto.mjs";

export function createWorker(deps = {}) {
  return {
    async fetch(request, env, ctx) {
      let config;
      try {
        config = configuration(env);
      } catch {
        return security(
          problem(503, "serverless_unconfigured", "V3 服务配置尚未完成"),
        );
      }
      const respond = (response, api = true) => security(response, config, api);
      const url = new URL(request.url);
      if (url.origin !== config.PUBLIC_URL)
        return respond(problem(403, "host_denied", "请使用正式访问地址"));
      if (url.href.length > 2048 || /%|\\|\/\//.test(url.pathname))
        return respond(problem(400, "invalid_path", "请求路径不正确"));
      const apiRoute = route(url.pathname, request.method);
      const adminPage =
        url.pathname === "/login" ||
        url.pathname === "/admin" ||
        url.pathname.startsWith("/admin/");
      const asset = url.pathname.startsWith("/assets/");
      if (url.pathname.startsWith("/api")) {
        if (!apiRoute) return respond(problem(404, "not_found", "接口不存在"));
        if (!apiRoute.allowed)
          return respond(problem(405, "method_not_allowed", "请求方法不支持"));
        if (
          url.search &&
          !(
            url.pathname === "/api/v1/admin/shares" &&
            /^\?page=[1-9][0-9]{0,4}$/.test(url.search)
          )
        )
          return respond(problem(400, "invalid_query", "请求参数不正确"));
      } else {
        if (!["GET", "HEAD"].includes(request.method))
          return respond(problem(405, "method_not_allowed", "请求方法不支持"));
        if (!(
          url.pathname === "/" ||
          adminPage ||
          /^\/s\/[A-Za-z0-9_-]{32}$/.test(url.pathname) ||
          /^\/assets\/[A-Za-z0-9._-]+$/.test(url.pathname) ||
          url.pathname === "/favicon.ico"
        ))
          return respond(problem(404, "not_found", "页面不存在"));
      }
      const origin = request.headers.get("Origin");
      if (
        (origin && origin !== config.PUBLIC_URL) ||
        (apiRoute &&
          ((!["GET", "HEAD"].includes(request.method) &&
            origin !== config.PUBLIC_URL) ||
            request.headers.get("Sec-Fetch-Site") === "cross-site"))
      )
        return respond(problem(403, "origin_denied", "请求来源不受信任"));
      let identity;
      if (adminPage || apiRoute?.admin) {
        try {
          identity = await (deps.verifyAccess || verifyAccess)(request, config);
        } catch {
          return respond(
            problem(401, "access_required", "请通过管理入口验证身份"),
          );
        }
      }
      if (!apiRoute) {
        if (url.pathname === "/login")
          return respond(
            new Response(null, {
              status: 303,
              headers: { Location: "/admin" },
            }),
          );
        const target = new URL(request.url);
        if (!asset && url.pathname !== "/favicon.ico") target.pathname = "/";
        const response = respond(
          await env.ASSETS.fetch(new Request(target, request)),
          adminPage,
        );
        if (!asset) response.headers.set("Cache-Control", "private, no-store");
        return response;
      }
      if (!config.enabled)
        return respond(problem(503, "maintenance", "服务正在维护，请稍后重试"));
      const service = new Service(config, ctx, deps);
      try {
        if (
          identity &&
          !["GET", "HEAD"].includes(request.method) &&
          !equal(
            request.headers.get("X-CSRF-Token"),
            await service.csrf(identity),
          )
        )
          throw new Problem(403, "csrf_denied", "请求验证失败，请刷新页面");
        await service.limits(request, url.pathname, identity);
        const length = request.headers.get("Content-Length");
        if (length && (!/^\d+$/.test(length) || Number(length) > 65536))
          throw new Problem(413, "body_too_large", "请求正文过大");
        let bytes;
        try {
          bytes = await readBody(request, deps.bodyTimeoutMs || 15000);
        } catch (e) {
          throw new Problem(
            e.message === "Body read timeout" ? 408 : 413,
            e.message === "Body read timeout"
              ? "request_timeout"
              : "body_too_large",
            "请求正文过大或读取超时",
          );
        }
        let data = {};
        if (bytes.length) {
          if (
            request.headers
              .get("Content-Type")
              ?.split(";")[0]
              .trim()
              .toLowerCase() !== "application/json"
          )
            throw new Problem(415, "json_required", "请使用 JSON 请求正文");
          try {
            data = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            );
            if (!data || typeof data !== "object" || Array.isArray(data))
              throw new Error();
          } catch {
            throw new Problem(
              400,
              "invalid_json",
              "请求正文必须是单个 JSON 对象",
            );
          }
        }
        return respond(
          await service.dispatch(
            url.pathname,
            request.method,
            data,
            identity,
            request,
          ),
        );
      } catch (e) {
        const result = problem(
          e.status || 503,
          e.code || "storage_unavailable",
          e.status ? e.message : "服务暂时不可用，请稍后重试",
        );
        if (e.status === 429) result.headers.set("Retry-After", "60");
        if (e.status === 503) result.headers.set("Retry-After", "2");
        return respond(result);
      }
    },
    async scheduled(controller, env, ctx) {
      const config = configuration(env);
      if (!config.enabled) return;
      await new Service(config, ctx, deps).maintain();
    },
  };
}
export default createWorker();
