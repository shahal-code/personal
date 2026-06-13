import { useEffect, useMemo, useRef, useState } from "react";
import { fetchText, resolveUrl, request } from "../api/http.js";

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
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [loading, setLoading] = useState(kind === "text");
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [transcodeStatus, setTranscodeStatus] = useState(null);
  const [hlsModule, setHlsModule] = useState(null);
  const previewUrl = resolveUrl(`/preview?path=${encodeURIComponent(item.path)}`);
  const livePreviewUrl = resolveUrl(`/preview/live?path=${encodeURIComponent(item.path)}`);
  const hlsUrl = resolveUrl(`/preview/hls?path=${encodeURIComponent(item.path)}`);
  const supportsNativeHls = useMemo(() => {
    const video = document.createElement("video");
    return video.canPlayType("application/vnd.apple.mpegurl");
  }, []);

  const useHls = kind === "video" && transcodeStatus?.hlsReady;
  const streamUrl = useHls ? hlsUrl : livePreviewUrl;

  useEffect(() => {
    let active = true;

    async function loadPreview() {
      setError("");
      setText("");

      if (kind === "video" || kind === "audio" || kind === "image" || kind === "pdf" || kind === "generic") {
        setLoading(false);
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

  useEffect(() => {
    if (kind !== "video") {
      return undefined;
    }

    let active = true;

    async function loadStatus() {
      try {
        const status = await request(`/video/transcode/status?path=${encodeURIComponent(item.path)}`);
        if (!active) {
          return;
        }
        setTranscodeStatus(status);
      } catch {
        if (!active) {
          return;
        }
        setTranscodeStatus(null);
      }
    }

    loadStatus();
    const interval = window.setInterval(loadStatus, 3000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [item.path, kind]);

  useEffect(() => {
    if (kind !== "video" || !transcodeStatus?.hlsReady || hlsModule) {
      return undefined;
    }

    let active = true;
    import("hls.js").then((module) => {
      if (!active) {
        return;
      }

      setHlsModule(module.default || module);
    });

    return () => {
      active = false;
    };
  }, [kind, transcodeStatus?.hlsReady, hlsModule]);

  useEffect(() => {
    if (kind !== "video") {
      return undefined;
    }

    const videoElement = videoRef.current;
    if (!videoElement) {
      return undefined;
    }

    if (!useHls) {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      videoElement.src = streamUrl;
      videoElement.load();
      return undefined;
    }

    if (hlsModule?.isSupported?.()) {
      const hls = new hlsModule({
        enableWorker: true,
        lowLatencyMode: true,
        xhrSetup(xhr) {
          xhr.withCredentials = true;
        },
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(videoElement);
      hlsRef.current = hls;

      hls.on(hlsModule.Events.ERROR, (_, data) => {
        if (data?.fatal) {
          hls.destroy();
          hlsRef.current = null;
          videoElement.src = streamUrl;
          videoElement.load();
          setTranscodeStatus((current) => ({ ...current, hlsReady: false }));
        }
      });

      return () => {
        hls.destroy();
        if (hlsRef.current === hls) {
          hlsRef.current = null;
        }
      };
    }

    videoElement.src = hlsUrl;
    return undefined;
  }, [kind, hlsModule, hlsUrl, streamUrl, useHls]);

  useEffect(
    () => () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    },
    []
  );

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
            <video ref={videoRef} className="preview-media" controls autoPlay playsInline muted={false} crossOrigin="use-credentials" preload="metadata" />
          ) : kind === "audio" ? (
            <audio className="preview-media preview-media--audio" controls autoPlay src={previewUrl} crossOrigin="use-credentials" />
          ) : kind === "image" ? (
            <img className="preview-image" src={previewUrl} alt={item.name} crossOrigin="use-credentials" />
          ) : kind === "pdf" ? (
            <iframe className="preview-embed" title={item.name} src={previewUrl} />
          ) : kind === "text" ? (
            <pre className="preview-text">{text}</pre>
          ) : (
            <div className="empty-state">This file cannot be previewed in-browser.</div>
          )}
        </div>

        {kind === "video" && transcodeStatus ? (
          <div className="preview-status">
            <span>Playback</span>
            <strong>{transcodeStatus.status === "ready" ? "HLS ready" : transcodeStatus.status === "processing" ? "Transcoding" : "Direct stream"}</strong>
          </div>
        ) : null}
      </div>
    </div>
  );
}
