import { formatBytes, formatPercent, formatTemperature } from "../api/http.js";

export default function StoragePanel({ storage, systemStatus }) {
  const total = Number(storage?.totalBytes || 0);
  const used = Number(storage?.usedBytes || 0);
  const free = Number(storage?.freeBytes || 0);
  const usedPercent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const batteryPercent = systemStatus?.battery?.percentage ?? systemStatus?.batteryPercentage ?? null;
  const temperature = systemStatus?.temperature?.celsius ?? systemStatus?.temperatureCelsius ?? null;
  const memoryPercent =
    Number.isFinite(Number(systemStatus?.memory?.usedBytes)) && Number.isFinite(Number(systemStatus?.memory?.totalBytes))
      ? Math.round((Number(systemStatus.memory.usedBytes) / Number(systemStatus.memory.totalBytes)) * 100)
      : null;
  const batteryState =
    systemStatus?.battery?.charging == null
      ? "Power state unavailable"
      : systemStatus.battery.charging
        ? "Charging"
        : "On battery";

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
      <div className="status-grid">
        <article className="status-card">
          <span>Battery</span>
          <strong>{formatPercent(batteryPercent)}</strong>
          <p>{batteryPercent == null ? "Install Termux:API for live battery stats" : batteryState}</p>
        </article>
        <article className="status-card">
          <span>Temperature</span>
          <strong>{formatTemperature(temperature)}</strong>
          <p>{temperature == null ? "Install Termux:API for live temperature" : systemStatus?.temperature?.source || "Best-effort sensor reading"}</p>
        </article>
        <article className="status-card">
          <span>Memory</span>
          <strong>{memoryPercent == null ? "N/A" : `${memoryPercent}%`}</strong>
          <p>
            {systemStatus?.memory
              ? `${formatBytes(systemStatus.memory.usedBytes)} of ${formatBytes(systemStatus.memory.totalBytes)}`
              : "System memory unavailable"}
          </p>
        </article>
        <article className="status-card">
          <span>Uptime</span>
          <strong>{systemStatus?.uptime?.humanReadable || "N/A"}</strong>
          <p>{systemStatus?.hostname || "Server status"}</p>
        </article>
      </div>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${usedPercent}%` }} />
      </div>
    </section>
  );
}
