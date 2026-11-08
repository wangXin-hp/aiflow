import { useAuth } from "./auth-state";
export function SessionStatus() {
  const { status, error, retry } = useAuth();
  return (
    <main className="auth-card">
      {status === "loading" ? (
        <p role="status">正在检查登录状态…</p>
      ) : (
        <>
          <p role="alert" aria-live="polite">
            {error?.message}
          </p>
          <button onClick={retry}>重试</button>
        </>
      )}
    </main>
  );
}
