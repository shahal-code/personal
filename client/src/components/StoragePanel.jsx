import { formatBytes, formatDate, formatPercent, formatTemperature } from "../api/http.js";

export default function StoragePanel({ storage, systemStatus, transferStatus }) {
  const total = Number(storage?.totalBytes || 0);
  const used = Number(storage?.usedBytes || 0);
  const free = Number(storage?.freeBytes || 0);
  const usedPercent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const freePercent = total > 0 ? Math.max(0, Math.round((free / total) * 100)) : 0;
  const lowStorage = total > 0 && (freePercent <= 10 || free < 5 * 1024 * 1024 * 1024);
  const batteryPercent = systemStatus?.battery?.percentage ?? null;
  const temperature = systemStatus?.temperature?.celsius ?? null;
  const lowBattery = batteryPercent != null && batteryPercent <= 20 && !systemStatus?.battery?.charging;
  const highTemperature = temperature != null && temperature >= 42;
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
  const fileTypeEntries = Object.entries(storage?.fileTypes || {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);
  const fileTypeSummary =
    fileTypeEntries.length > 0
      ? fileTypeEntries.map(([extension, count]) => `${extension.toUpperCase()} ${count}`).join(" · ")
      : "No files";
  const network = systemStatus?.network;
  const cpuPercentage = Number(systemStatus?.cpu?.percentage);
  const formattedCpuPercentage = Number.isFinite(cpuPercentage)
    ? `${Math.max(0, Math.min(100, cpuPercentage)).toFixed(1)}%`
    : "N/A";

  return (
    <section className="storage-panel">
      <div className="storage-panel__header">
        <div>
          <p className="eyebrow">Storage</p>
          <h2>Capacity at a glance</h2>
        </div>
        <span className="status-pill">{usedPercent}% used</span>
      </div>
      <div className="warning-list">
        {lowStorage ? (
          <div className="storage-warning storage-warning--danger">
            <strong>Low storage</strong>
            <span>{formatBytes(free)} free. Large uploads may fail.</span>
          </div>
        ) : null}
        {lowBattery ? (
          <div className="storage-warning">
            <strong>Low battery</strong>
            <span>{formatPercent(batteryPercent)} remaining. Connect the charger before large transfers.</span>
          </div>
        ) : null}
        {highTemperature ? (
          <div className="storage-warning storage-warning--danger">
            <strong>High temperature</strong>
            <span>{formatTemperature(temperature)}. Pause large transfers until the device cools.</span>
          </div>
        ) : null}
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
        <article className="metric-card">
          <span>Folders</span>
          <strong>{storage?.directoryCount ?? 0}</strong>
        </article>
        <article className="metric-card">
          <span>Storage health</span>
          <strong className={`health-text health-text--${storage?.health?.status || "healthy"}`}>
            {storage?.health?.label || "Healthy"}
          </strong>
        </article>
        <article className="metric-card">
          <span>Largest file</span>
          <strong>{storage?.largestFile ? formatBytes(storage.largestFile.size) : "N/A"}</strong>
          <small title={storage?.largestFile?.name || ""}>{storage?.largestFile?.name || "No files"}</small>
        </article>
        <article className="metric-card">
          <span>Active uploads</span>
          <strong>{transferStatus?.activeUploads || 0}</strong>
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
          <p>{temperature == null ? "Temperature unavailable" : "Live sensor reading"}</p>
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
          <p>Server status</p>
        </article>
        <article className="status-card">
          <span>CPU usage</span>
          <strong>{formattedCpuPercentage}</strong>
          <p>{systemStatus?.cpu?.cores ? `${systemStatus.cpu.cores} logical cores` : "CPU unavailable"}</p>
        </article>
        <article className="status-card">
          <span>Upload speed</span>
          <strong>{formatBytes(transferStatus?.uploadBytesPerSecond || network?.uploadBytesPerSecond || 0)}/s</strong>
          <p>{transferStatus?.activeUploads ? "Current browser upload" : "Server network traffic"}</p>
        </article>
        <article className="status-card">
          <span>Download speed</span>
          <strong>{formatBytes(network?.downloadBytesPerSecond || 0)}/s</strong>
          <p>Server network traffic</p>
        </article>
        <article className="status-card">
          <span>Network</span>
          <strong>{network?.connected ? "Online" : "Offline"}</strong>
          <p>{network?.type || "Network status unavailable"}</p>
        </article>
        <article className="status-card">
          <span>File types</span>
          <strong>{Object.keys(storage?.fileTypes || {}).length}</strong>
          <p title={fileTypeSummary}>{fileTypeSummary}</p>
        </article>
        <article className="status-card">
          <span>Last sync</span>
          <strong>{storage?.lastSyncAt ? formatDate(storage.lastSyncAt) : "Never"}</strong>
          <p>Latest stored-file activity</p>
        </article>
      </div>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${usedPercent}%` }} />
      </div>
    </section>
  );
}
