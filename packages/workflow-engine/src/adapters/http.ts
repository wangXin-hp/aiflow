import type { JsonObject, JsonValue } from "@aiflow/contracts";
import type { HttpAdapterV2 } from "../v2/nodes.js";
import { readBoundedText } from "./response.js";

/** 仅访问调用方显式允许的 URL；不自动跟随重定向。部署方仍需限制网络出口和 DNS。 */
export function createFetchHttpAdapter(options: {
  allowUrl: (url: URL) => boolean;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}): HttpAdapterV2 {
  const send = options.fetch ?? fetch;
  return {
    async request(request) {
      const url = new URL(request.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("HTTP target is not allowed");
      for (const [key, value] of Object.entries(request.params ?? {})) {
        if (!["string", "number", "boolean"].includes(typeof value))
          throw new TypeError("HTTP query values must be scalar");
        url.searchParams.append(key, String(value));
      }
      // 所有 query 参数加入后再执行策略校验，确保策略检查的是实际请求地址。
      if (!options.allowUrl(url)) throw new Error("HTTP target is not allowed");
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers ?? {})) {
        if (typeof value !== "string")
          throw new TypeError("HTTP header values must be strings");
        headers.set(key, value);
      }
      let body: BodyInit | undefined;
      const bodyType =
        request.bodyType ?? (typeof request.body === "string" ? "raw" : "json");
      if (
        request.body !== undefined &&
        request.body !== null &&
        bodyType !== "none"
      ) {
        if (["GET", "HEAD"].includes(request.method))
          throw new TypeError("HTTP method does not support a body");
        if (bodyType === "raw") {
          if (typeof request.body !== "string")
            throw new TypeError("Raw body must be a string");
          body = request.body;
        } else if (bodyType === "json") {
          body = JSON.stringify(request.body);
          if (!headers.has("content-type"))
            headers.set("content-type", "application/json");
        } else {
          if (typeof request.body !== "object" || Array.isArray(request.body))
            throw new TypeError("Form body must be an object");
          const form =
            bodyType === "form-data" ? new FormData() : new URLSearchParams();
          for (const [key, value] of Object.entries(request.body)) {
            if (!["string", "number", "boolean"].includes(typeof value))
              throw new TypeError("Form values must be scalar");
            form.append(key, String(value));
          }
          if (bodyType === "form-data" && headers.has("content-type"))
            throw new TypeError("Form-data content-type must be set by fetch");
          if (
            bodyType === "x-www-form-urlencoded" &&
            !headers.has("content-type")
          )
            headers.set(
              "content-type",
              "application/x-www-form-urlencoded;charset=UTF-8",
            );
          body = form;
        }
      }
      const response = await send(url, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
        redirect: "manual",
      });
      const text = await readBoundedText(
        response,
        options.maxResponseBytes ?? 1_048_576,
      );
      let data: JsonValue = text;
      if (
        text &&
        /(?:application\/json|\+json)(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        data = JSON.parse(text) as JsonValue;
      const resultHeaders: JsonObject = Object.create(null) as JsonObject;
      response.headers.forEach((value, key) => {
        resultHeaders[key] = value;
      });
      return { status: response.status, headers: resultHeaders, data };
    },
  };
}
