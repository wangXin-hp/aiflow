import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./auth/protected-route";
import { LoginPage } from "./pages/login-page";
import { VerifyEmailPage } from "./pages/verify-email-page";
import { AppHomePage } from "./pages/app-home-page";

/** 工作台和编辑器入口共享会话保护，创建成功后可直接进入草稿地址。 */
export function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/account/login" element={<LoginPage />} />
        <Route path="/account/verify" element={<VerifyEmailPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/apps" element={<AppHomePage />} />
          <Route
            path="/workflows/:id"
            element={
              <main className="auth-card">
                <h1>工作流编辑器</h1>
                <Link className="back-link" to="/apps">
                  返回工作流列表
                </Link>
              </main>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/apps" replace />} />
      </Routes>
    </div>
  );
}
