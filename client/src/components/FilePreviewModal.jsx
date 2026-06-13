import { useEffect, useMemo, useRef, useState } from "react";
import { download, fetchText, resolveUrl, request } from "../api/http.js";

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
  const [downloading, setDownloading] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const previewUrl = resolveUrl(`/preview?path=${encodeURIComponent(item.path)}`);
  const livePreviewUrl = resolveUrl(`/preview/live?path=${encodeURIComponent(item.path)}`);
  const hlsUrl = resolveUrl(`/preview/hls?path=${encodeURIComponent(item.path)}`);
  const supportsNativeHls = useMemo(() => {
    const video = document.createElement("video");
    return video.canPlayType("application/vnd.apple.mpegurl");
  }, []);

  const useHls = kind === "video" && transcodeStatus?.hlsReady && !videoError;
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

      videoElement.src = livePreviewUrl;
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
          // ✅ fallback to direct stream instead of blank screen
          setVideoError(true);
          if (videoRef.current) {
            videoRef.current.src = livePreviewUrl;
            videoRef.current.load();
            videoRef.current.play().catch(() => {});
          }
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
  }, [kind, hlsModule, hlsUrl, livePreviewUrl, useHls]);

  // ✅ Timeout fallback — if video not loading after 5 seconds, force direct stream
  useEffect(() => {
    if (kind !== "video") return undefined;

    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (video && video.readyState === 0) {
        console.warn("Video not loading, falling back to direct stream");
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
        setVideoError(true);
        video.src = livePreviewUrl;
        video.load();
        video.play().catch(() => {});
      }
    }, 5000);

    return () => window.clearTimeout(timer);
  }, [kind, livePreviewUrl]);

  useEffect(
    () => () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    },
    []
  );

  async function handleDownload() {
    setDownloading(true);

    try {
      await download(`/download?path=${encodeURIComponent(item.path)}`, item.name);
    } finally {
      setDownloading(false);
    }
  }

  function handleVideoError(e) {
    const video = e.currentTarget;
    // If already on direct stream and still failing, show error
    if (video.src === livePreviewUrl) {
      setError("Unable to play this video");
      return;
    }
    // Otherwise fall back to direct stream
    console.warn("Video error, falling back to direct stream");
    setVideoError(true);
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    video.src = livePreviewUrl;
    video.load();
    video.play().catch(() => {});
  }

  function handleVideoStalled() {
    const video = videoRef.current;
    if (video && video.src !== livePreviewUrl) {
      video.src = livePreviewUrl;
      video.load();
      video.play().catch(() => {});
    }
  }

  return (
    <div className="modal-backdrop modal-backdrop--wide" role="presentation" onMouseDown={onClose}>
      <div className="modal-card modal-card--preview" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Preview</p>
            <h3>{item.name}</h3>
            <p className="modal-subtitle">{item.displayPath}</p>
          </div>
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={handleDownload} disabled={downloading}>
              {downloading ? "Downloading..." : "Download"}
            </button>
            <button className="icon-button" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="preview-frame">
          {loading ? (
            <div className="empty-state">Loading preview...</div>
          ) : error ? (
            <div className="error-banner">{error}</div>
          ) : kind === "video" ? (
            <video
              ref={videoRef}
              className="preview-media"
              controls
              autoPlay
              playsInline
              muted={false}
              crossOrigin="use-credentials"
              preload="metadata"
              onError={handleVideoError}
              onStalled={handleVideoStalled}
            />
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
            <strong>
              {videoError
                ? "Direct stream (fallback)"
                : transcodeStatus.status === "ready"
                  ? "HLS ready"
                  : transcodeStatus.status === "processing"
                    ? "Transcoding"
                    : "Direct stream"}
            </strong>
          </div>
        ) : null}
      </div>
    </div>
  );
}