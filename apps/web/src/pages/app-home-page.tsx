import { useState } from "react";
import { ApiClientError } from "../auth/auth-api";
import { useAuth } from "../auth/auth-state";
export function AppHomePage() {
  const { user, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [avatarFailed, setAvatarFailed] = useState(false);
  if (!user) return null;
  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await logout();
    } catch (failure) {
      setError(
        failure instanceof ApiClientError
          ? failure.message
          : "退出失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-card workspace-card">
      <p className="brand">
        AI<span>Flow</span>
      </p>
      <p className="eyebrow">你的工作空间</p>
      <h1>开始创造</h1>
      <p className="description">工作流功能即将到来，期待与你一起探索。</p>
      <div className="profile">
        <div className="avatar" aria-hidden="true">
          {user.avatarUrl && !avatarFailed ? (
            <img
              src={user.avatarUrl}
              alt=""
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            Array.from(user.name || user.email)[0]?.toUpperCase()
          )}
        </div>
        <div className="profile-details">
          <strong>{user.name || "AIFlow 用户"}</strong>
          <p>{user.email}</p>
        </div>
      </div>
      {error && (
        <p className="error-banner" role="alert" aria-live="polite">
          {error}
        </p>
      )}
      <button
        className="secondary"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          void signOut();
        }}
      >
        {busy ? "正在退出…" : "退出登录"}
      </button>
    </main>
  );
}
