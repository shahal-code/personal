import { formatBytes } from "../api/http.js";

export default function StoragePanel({ storage }) {
  const total = Number(storage?.totalBytes || 0);
  const used = Number(storage?.usedBytes || 0);
  const free = Number(storage?.freeBytes || 0);
  const usedPercent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

  return (
    <section className="storage-panel">
      <div className="storage-panel__header">
        <div>
          <p className="eyebrow">Storage</p>
          <h2>Capacity at a glance</h2>
        </div>
        <span className="status-pill">{usedPercent}% used</span>
      </div>
      <div className="storage-grid">
        <article className="metric-card">
          <span>Total</span>
          <strong>{formatBytes(total)}</strong>
        </article>
        <article className="metric-card">
          <span>Used</span>
          <strong>{formatBytes(used)}</strong>
        </article>
        <article className="metric-card">
          <span>Free</span>
          <strong>{formatBytes(free)}</strong>
        </article>
        <article className="metric-card">
          <span>Files</span>
          <strong>{storage?.fileCount ?? 0}</strong>
        </article>
      </div>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${usedPercent}%` }} />
      </div>
    </section>
  );
}
