import { useState, type FormEvent } from "react";
import { ResendVerificationRequestSchema } from "@aiflow/contracts";
import { ApiClientError, authApi } from "./auth-api";

type ResendVerificationFormProps = {
  initialEmail?: string;
  onSuccess?: (message: string) => void;
};

/** 为首次投递失败、未验证登录和过期链接提供同一条账号无关恢复路径。 */
export function ResendVerificationForm({
  initialEmail = "",
  onSuccess,
}: ResendVerificationFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = ResendVerificationRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setError("请输入有效邮箱");
      return;
    }
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const result = await authApi.resendVerification(parsed.data);
      if (onSuccess) onSuccess(result.message);
      else setMessage(result.message);
    } catch (failure) {
      setError(
        failure instanceof ApiClientError
          ? failure.message
          : "请求失败，请稍后重试",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="resend-form" onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label htmlFor="resend-email">邮箱</label>
        <input
          id="resend-email"
          type="email"
          autoComplete="email"
          value={email}
          disabled={submitting}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <button
        className="text-button"
        type="submit"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? "正在发送…" : "重新发送验证邮件"}
      </button>
      {message && (
        <p className="notice" role="status" aria-live="polite">
          {message}
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert" aria-live="polite">
          {error}
        </p>
      )}
    </form>
  );
}
