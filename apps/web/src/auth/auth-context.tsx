import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiClientError, authApi } from "./auth-api";
import { AuthContext, type AuthState } from "./auth-state";

type Session = Pick<AuthState, "user" | "status" | "error">;
const anonymous: Session = { user: null, status: "ready", error: null };

/** 可取消初始化请求；旧结果不得覆盖较新的登录或退出状态。 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({
    user: null,
    status: "loading",
    error: null,
  });
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const current = ++revision.current;
    authApi
      .me(controller.signal)
      .then(({ user }) => {
        if (!controller.signal.aborted && revision.current === current)
          setSession({ user, status: "ready", error: null });
      })
      .catch((error: ApiClientError) => {
        if (controller.signal.aborted || revision.current !== current) return;
        // 只有身份失效可降为匿名，基础设施故障保留显式恢复入口。
        setSession(
          error.status === 401
            ? anonymous
            : { user: null, status: "error", error },
        );
      });
    return () => controller.abort();
  }, [attempt]);
  const value: AuthState = {
    ...session,
    retry: () => {
      setSession({ user: null, status: "loading", error: null });
      setAttempt((value) => value + 1);
    },
    login: async (input) => {
      const { user } = await authApi.login(input);
      revision.current += 1;
      setSession({ user, status: "ready", error: null });
    },
    logout: async () => {
      try {
        await authApi.logout();
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.status !== 401)
          throw error;
      }
      revision.current += 1;
      setSession(anonymous);
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
