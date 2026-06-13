import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      await signIn({ email, password });
      navigate("/app", { replace: true });
    } catch (requestError) {
      setError(requestError.message || "Unable to sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <p className="eyebrow">Admin Login</p>
        <h2>Enter credentials</h2>
        <label className="field">
          <span>Email</span>
          <input
            className="text-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@example.com"
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="text-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter your password"
            required
          />
        </label>
        {error ? <div className="error-banner">{error}</div> : null}
        <button className="primary-button primary-button--large" type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
