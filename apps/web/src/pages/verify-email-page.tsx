import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiClientError, authApi } from "../auth/auth-api";
import { ResendVerificationForm } from "../auth/resend-verification-form";

function Verification({
  token,
  onFailure,
}: {
  token: string;
  onFailure: () => void;
}) {
  const pending = useRef<ReturnType<typeof authApi.verify> | null>(null);
  const [state, setState] = useState<{
    status: "loading" | "success" | "error";
    message: string;
  }>({ status: "loading", message: "正在验证邮箱…" });
  useEffect(() => {
    let active = true;
    // token 只可消费一次：StrictMode 的 Effect 重放共享请求，不取消已开始的验证。
    pending.current ??= authApi.verify(token);
    pending.current
      .then(() => {
        if (active)
          setState({ status: "success", message: "邮箱验证成功，请登录" });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "error",
            message:
              error instanceof ApiClientError
                ? error.message
                : "验证失败，请稍后重试",
          });
          onFailure();
        }
      });
    return () => {
      active = false;
    };
  }, [onFailure, token]);
  return (
    <p
      className={state.status === "error" ? "error-banner" : "notice"}
      role={state.status === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {state.message}
    </p>
  );
}
export function VerifyEmailPage() {
  const [search] = useSearchParams();
  const token = search.get("token");
  const [showRecovery, setShowRecovery] = useState(!token);
  const showResend = useCallback(() => setShowRecovery(true), []);
  return (
    <main className="auth-card">
      <p className="brand">
        AI<span>Flow</span>
      </p>
      <h1>验证邮箱</h1>
      {token ? (
        <Verification key={token} token={token} onFailure={showResend} />
      ) : (
        <p className="error-banner" role="alert">
          缺少验证链接，请使用邮件中的完整链接。
        </p>
      )}
      {showRecovery && <ResendVerificationForm />}
      <Link className="back-link" to="/account/login">
        返回登录
      </Link>
    </main>
  );
}
