import { formatDate } from "../api/http.js";

function eventLabel(type) {
  return {
    login_success: "Login",
    login_failed: "Failed login",
    logout: "Logout",
    upload: "Upload",
    delete: "Delete",
    transfer: "Transfer",
    rename: "Rename",
    folder_created: "Folder created",
  }[type] || type;
}

export default function SecurityActivityPanel({ activity, loading, onRefresh }) {
  const sessions = activity?.activeSessions || [];
  const events = activity?.events || [];

  return (
    <section id="security" className="security-panel">
      <div className="security-panel__header">
        <div>
          <p className="eyebrow">Security</p>
          <h2>Activity and signed-in devices</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="section-heading">
        <h3>Active sessions</h3>
        <span>{sessions.length} signed in</span>
      </div>
      {sessions.length === 0 ? (
        <div className="empty-state">No active sessions recorded.</div>
      ) : (
        <div className="session-grid">
          {sessions.map((session) => (
            <article className="session-card" key={session.sessionId}>
              <div><span className="activity-dot activity-dot--success" /><strong>{session.email || "Administrator"}</strong></div>
              <dl>
                <div><dt>Device</dt><dd>{session.device}</dd></div>
                <div><dt>Browser</dt><dd>{session.browser}</dd></div>
                <div><dt>Country</dt><dd>{session.country}</dd></div>
                <div><dt>IP address</dt><dd>{session.ip}</dd></div>
                <div><dt>Signed in</dt><dd>{formatDate(session.createdAt)}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}

      <div className="section-heading security-events-heading">
        <h3>Recent activity</h3>
        <span>{events.length} events</span>
      </div>
      {events.length === 0 ? (
        <div className="empty-state">Security events will appear here.</div>
      ) : (
        <div className="activity-list">
          {events.map((event) => (
            <article className="activity-item" key={event.id}>
              <span className={`activity-dot activity-dot--${event.outcome === "success" ? "success" : "danger"}`} />
              <div className="activity-item__main">
                <strong>{eventLabel(event.type)}</strong>
                <span>{event.detail || event.email || "Administrator action"}</span>
              </div>
              <div className="activity-item__client">
                <strong>{event.device} · {event.browser}</strong>
                <span>{event.country} · {event.ip}</span>
              </div>
              <time>{formatDate(event.createdAt)}</time>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
