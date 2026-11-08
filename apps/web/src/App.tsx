import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./auth/protected-route";
import { LoginPage } from "./pages/login-page";
import { VerifyEmailPage } from "./pages/verify-email-page";
import { AppHomePage } from "./pages/app-home-page";

export function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/account/login" element={<LoginPage />} />
        <Route path="/account/verify" element={<VerifyEmailPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/apps" element={<AppHomePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/apps" replace />} />
      </Routes>
    </div>
  );
}
