import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./auth/protected-route";
import { LoginPage } from "./pages/login-page";
import { VerifyEmailPage } from "./pages/verify-email-page";
import { AppHomePage } from "./pages/app-home-page";

// 登录和列表无需加载画布运行时，进入编辑器时才下载这一页面。
const WorkflowEditorPage = lazy(() =>
  import("./pages/workflow-editor-page").then(({ WorkflowEditorPage }) => ({
    default: WorkflowEditorPage,
  })),
);

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
              <Suspense fallback={<p role="status">正在打开工作流编辑器</p>}>
                <WorkflowEditorPage />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/apps" replace />} />
      </Routes>
    </div>
  );
}
