import { createContext, useContext } from "react";
import type { LoginRequest, PublicUser } from "@aiflow/contracts";
import type { ApiClientError } from "./auth-api";

export interface AuthState {
  user: PublicUser | null;
  status: "loading" | "ready" | "error";
  error: ApiClientError | null;
  retry: () => void;
  login: (input: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}
export const AuthContext = createContext<AuthState | null>(null);

/** 所有认证消费者共享同一 Provider，避免会话缓存相互矛盾。 */
export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error("AuthProvider is required");
  return state;
}
