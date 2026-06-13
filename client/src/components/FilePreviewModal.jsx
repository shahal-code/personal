import { useEffect, useMemo, useState } from "react";
import { fetchText, resolveUrl } from "../api/http.js";

function getPreviewKind(item) {
  const extension = (item?.extension || "").toLowerCase();
  if (!extension) {
    return "generic";
  }

  if (["mp4", "m4v", "mov", "webm", "mkv", "avi"].includes(extension)) {
    return "video";
  }

  if (["mp3", "m4a", "wav", "ogg"].includes(extension)) {
    return "audio";
  }

  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(extension)) {
    return "image";
  }

  if (extension === "pdf") {
    return "pdf";
  }

  if (["txt", "md", "json", "csv", "log"].includes(extension)) {
    return "text";
  }

  return "generic";
}

export default function FilePreviewModal({ item, onClose }) {
  const kind = useMemo(() => getPreviewKind(item), [item]);
  const [loading, setLoading] = useState(kind !== "video" && kind !== "audio" && kind !== "image" && kind !== "pdf");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const previewUrl = resolveUrl(`/preview?path=${encodeURIComponent(item.path)}`);
  const livePreviewUrl = resolveUrl(`/preview/live?path=${encodeURIComponent(item.path)}`);

  useEffect(() => {
    let active = true;

    async function loadPreview() {
      setError("");
      setText("");

        if (kind === "video" || kind === "audio" || kind === "image" || kind === "pdf" || kind === "generic") {
          setLoading(kind === "generic");
          return;
        }

      setLoading(true);

      try {
        const content = await fetchText(`/preview?path=${encodeURIComponent(item.path)}`);
        if (!active) {
          return;
        }
        setText(content);
      } catch (previewError) {
        if (!active) {
          return;
        }
        setError(previewError.message || "Unable to preview file");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    if (item?.path) {
      loadPreview();
    }

    return () => {
      active = false;
    };
  }, [item?.path, kind]);

  return (
    <div className="modal-backdrop modal-backdrop--wide" role="presentation" onMouseDown={onClose}>
      <div className="modal-card modal-card--preview" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Preview</p>
            <h3>{item.name}</h3>
            <p className="modal-subtitle">{item.displayPath}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="preview-frame">
          {loading ? (
            <div className="empty-state">Loading preview...</div>
          ) : error ? (
            <div className="error-banner">{error}</div>
          ) : kind === "video" ? (
          <video className="preview-media" controls autoPlay playsInline src={livePreviewUrl || previewUrl} />
        ) : kind === "audio" ? (
          <audio className="preview-media preview-media--audio" controls autoPlay src={previewUrl} />
          ) : kind === "image" ? (
            <img className="preview-image" src={previewUrl} alt={item.name} />
          ) : kind === "pdf" ? (
            <iframe className="preview-embed" title={item.name} src={previewUrl} />
          ) : kind === "text" ? (
            <pre className="preview-text">{text}</pre>
          ) : (
            <div className="empty-state">This file cannot be previewed in-browser.</div>
          )}
        </div>
      </div>
    </div>
  );
}
