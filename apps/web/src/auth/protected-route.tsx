import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./auth-state";
import { SessionStatus } from "./session-status";

/** 保留完整站内地址；初始化期间不渲染受保护内容或提前跳转。 */
export function ProtectedRoute() {
  const { user, status } = useAuth();
  const location = useLocation();
  if (status !== "ready") return <SessionStatus />;
  if (!user)
    return (
      <Navigate
        to={`/account/login?${new URLSearchParams({ redirect: location.pathname + location.search + location.hash })}`}
        replace
      />
    );
  return <Outlet />;
}
