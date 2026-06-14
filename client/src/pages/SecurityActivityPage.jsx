import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { request } from "../api/http.js";
import SecurityActivityPanel from "../components/SecurityActivityPanel.jsx";

export default function SecurityActivityPage() {
  const navigate = useNavigate();
  const [activity, setActivity] = useState({ activeSessions: [], events: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadActivity() {
    setLoading(true);
    setError("");
    try {
      setActivity(await request("/security-activity?limit=200"));
    } catch (requestError) {
      setError(requestError.message || "Unable to load security activity");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadActivity();
    const interval = window.setInterval(loadActivity, 15000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <main className="standalone-page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Phone Cloud</p>
          <h1>Security Activity</h1>
        </div>
        <button className="secondary-button" type="button" onClick={() => navigate("/app")}>
          Back to dashboard
        </button>
      </header>
      {error ? <div className="error-banner">{error}</div> : null}
      <SecurityActivityPanel activity={activity} loading={loading} onRefresh={loadActivity} />
    </main>
  );
}
