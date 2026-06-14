import { useEffect, useState } from "react";
import { request } from "../api/http.js";

export default function AccessModeButtons() {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    request("/access-config").then(setConfig).catch(() => setConfig(null));
  }, []);

  if (!config) return null;

  function switchTo(url) {
    if (!url) return;
    window.location.assign(`${url.replace(/\/+$/, "")}/login`);
  }

  const currentOrigin = window.location.origin;
  return (
    <div className="access-mode" aria-label="Connection mode">
      <span>Connection</span>
      <button
        className={`access-mode__button ${config.localUrl && currentOrigin === config.localUrl ? "access-mode__button--active" : ""}`}
        type="button"
        onClick={() => switchTo(config.localUrl)}
        disabled={!config.localUrl}
        title={config.localUrl || "Local Wi-Fi address unavailable"}
      >
        Local Wi-Fi
      </button>
      <button
        className={`access-mode__button ${config.publicUrl && currentOrigin === config.publicUrl ? "access-mode__button--active" : ""}`}
        type="button"
        onClick={() => switchTo(config.publicUrl)}
        disabled={!config.publicUrl}
        title={config.publicUrl || "Public address not configured"}
      >
        Public
      </button>
    </div>
  );
}
