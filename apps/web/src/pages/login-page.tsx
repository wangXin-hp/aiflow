import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoginRequestSchema, RegisterRequestSchema } from "@aiflow/contracts";
import type { z } from "zod";
import { ApiClientError, authApi } from "../auth/auth-api";
import { useAuth } from "../auth/auth-state";
import { sanitizeRedirect } from "../auth/redirect";
import { SessionStatus } from "../auth/session-status";

type Fields = z.input<typeof RegisterRequestSchema>;
export function LoginPage() {
  const auth = useAuth();
  const [search] = useSearchParams();
  const [registering, setRegistering] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<Fields>({
    resolver: zodResolver(
      registering ? RegisterRequestSchema : LoginRequestSchema,
    ),
    defaultValues: { email: "", password: "" },
    shouldUnregister: true,
  });
  if (auth.status !== "ready") return <SessionStatus />;
  if (auth.user)
    return <Navigate to={sanitizeRedirect(search.get("redirect"))} replace />;
  function changeMode() {
    // 切换模式时仅保留邮箱，避免隐藏字段与敏感凭据进入下一次请求。
    reset({ email: getValues("email"), password: "" });
    setRegistering(!registering);
    setError("");
    setNotice("");
  }
  const submit = handleSubmit(async (values) => {
    setError("");
    setNotice("");
    try {
      if (registering) {
        await authApi.register(RegisterRequestSchema.parse(values));
        reset({ email: values.email, password: "" });
        setRegistering(false);
        setNotice("注册成功，请查收邮件并完成邮箱验证后登录。");
      } else {
        await auth.login(LoginRequestSchema.parse(values));
      }
    } catch (failure) {
      setError(
        failure instanceof ApiClientError
          ? failure.code === "EMAIL_NOT_VERIFIED"
            ? "邮箱尚未验证，请先查收验证邮件"
            : failure.message
          : "请求失败，请稍后重试",
      );
    }
  });
  return (
    <main className="auth-card">
      <a className="brand" href="/">
        AI<span>Flow</span>
        <span className="brand-mark" aria-hidden="true">
          ↗
        </span>
      </a>
      <p className="eyebrow">让想法流动起来</p>
      <h1>{registering ? "创建你的账号" : "欢迎回来"}</h1>
      <p className="description">
        {registering
          ? "从这里开始，构建你的 AI 工作流。"
          : "登录 AIFlow，继续探索你的工作空间。"}
      </p>
      {notice && (
        <p className="notice" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert" aria-live="polite">
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        {registering && (
          <div className="field">
            <label htmlFor="name">姓名（可选）</label>
            <input id="name" autoComplete="name" {...register("name")} />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            {...register("email")}
          />
          {errors.email && (
            <p className="field-error" id="email-error">
              请输入有效邮箱
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="password">密码</label>
          <input
            id="password"
            type="password"
            autoComplete={registering ? "new-password" : "current-password"}
            aria-invalid={!!errors.password}
            aria-describedby={
              errors.password
                ? "password-error"
                : registering
                  ? "password-hint"
                  : undefined
            }
            {...register("password")}
          />
          {registering && (
            <p className="hint" id="password-hint">
              至少 8 个字符，最多 72 个 UTF-8 字节
            </p>
          )}
          {errors.password && (
            <p className="field-error" id="password-error">
              {errors.password.type === "too_small"
                ? registering
                  ? "密码至少需要 8 个字符"
                  : "请输入密码"
                : errors.password.message}
            </p>
          )}
        </div>
        <button
          className="primary"
          type="submit"
          disabled={isSubmitting}
          aria-busy={isSubmitting}
        >
          {isSubmitting ? "正在提交…" : registering ? "注册" : "登录"}
        </button>
      </form>
      <p className="mode-switch">
        {registering ? "已有账号？" : "还没有账号？"}
        <button
          className="text-button"
          type="button"
          disabled={isSubmitting}
          onClick={changeMode}
        >
          {registering ? "返回登录" : "创建账号"}
        </button>
      </p>
      <p className="footer-note">连接灵感，让每一步更简单。</p>
    </main>
  );
}
