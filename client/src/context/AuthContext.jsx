import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { request } from "../api/http.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [status, setStatus] = useState("loading");
  const [email, setEmail] = useState("");

  async function refreshSession() {
    try {
      await request("/storage");
      setStatus("authenticated");
    } catch {
      setStatus("anonymous");
      setEmail("");
    }
  }

  useEffect(() => {
    refreshSession();
  }, []);

  async function signIn(credentials) {
    const payload = await request("/login", {
      method: "POST",
      body: credentials,
    });
    setEmail(payload.email || "");
    setStatus("authenticated");
    return payload;
  }

  async function signOut() {
    try {
      await request("/logout", { method: "POST" });
    } finally {
      setEmail("");
      setStatus("anonymous");
    }
  }

  const value = useMemo(
    () => ({
      status,
      email,
      isAuthenticated: status === "authenticated",
      refreshSession,
      signIn,
      signOut,
    }),
    [status, email]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return context;
}
