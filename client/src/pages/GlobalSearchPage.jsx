import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatBytes, formatDate, request } from "../api/http.js";

export default function GlobalSearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (query.trim().length < 2) {
      setItems([]);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const payload = await request(`/global-search?q=${encodeURIComponent(query.trim())}`);
        setItems(payload.items || []);
      } catch (requestError) {
        setError(requestError.message || "Search failed");
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function openLocation(item) {
    try {
      await request("/storage/root", { method: "PUT", body: { rootId: item.rootId } });
      const folder = item.type === "folder" ? item.path : item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
      navigate(folder ? `/app?path=${encodeURIComponent(folder)}` : "/app");
    } catch (requestError) {
      setError(requestError.message || "Unable to open storage location");
    }
  }

  return (
    <main className="standalone-page">
      <header className="topbar">
        <div><p className="eyebrow">Phone Cloud</p><h1>Global Search</h1></div>
        <button className="secondary-button" type="button" onClick={() => navigate("/app")}>Back to dashboard</button>
      </header>
      <section className="global-search-panel">
        <input className="text-input global-search-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search phone storage and SD card" autoFocus />
        {error ? <div className="error-banner">{error}</div> : null}
        {loading ? <div className="empty-state">Searching both storage locations...</div> : query.trim().length < 2 ? <div className="empty-state">Enter at least two characters.</div> : items.length === 0 ? <div className="empty-state">No matching files or folders.</div> : (
          <div className="search-results">
            {items.map((item) => (
              <button className="search-result" type="button" key={`${item.rootId}-${item.path}`} onClick={() => openLocation(item)}>
                <span className={`file-icon file-icon--${item.type}`}>{item.type === "folder" ? "DIR" : (item.extension || "FILE").slice(0, 3).toUpperCase()}</span>
                <span><strong>{item.name}</strong><small>{item.rootLabel} · {item.displayPath}</small></span>
                <span><strong>{item.type === "folder" ? "Folder" : formatBytes(item.size)}</strong><small>{formatDate(item.modifiedAt)}</small></span>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
