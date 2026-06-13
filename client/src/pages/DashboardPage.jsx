import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { request, upload, formatBytes, formatDate, resolveUrl } from "../api/http.js";
import { useAuth } from "../context/AuthContext.jsx";
import StoragePanel from "../components/StoragePanel.jsx";
import Modal from "../components/Modal.jsx";
import FilePreviewModal from "../components/FilePreviewModal.jsx";

const UPLOAD_SESSION_KEY = "phonecloud.uploadSession";
const UPLOAD_MODE_KEY = "phonecloud.uploadMode";

function readUploadSession() {
  try {
    const raw = window.sessionStorage.getItem(UPLOAD_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeUploadSession(payload) {
  try {
    window.sessionStorage.setItem(UPLOAD_SESSION_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors.
  }
}

function clearUploadSession() {
  try {
    window.sessionStorage.removeItem(UPLOAD_SESSION_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function readUploadMode() {
  try {
    const raw = window.localStorage.getItem(UPLOAD_MODE_KEY);
    return raw ? JSON.parse(raw) : { fastUploadMode: true };
  } catch {
    return { fastUploadMode: true };
  }
}

function writeUploadMode(payload) {
  try {
    window.localStorage.setItem(UPLOAD_MODE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors.
  }
}

function humanFileType(item) {
  if (item.type === "folder") {
    return "Folder";
  }

  const extension = item.extension || "file";
  return extension.toUpperCase();
}

function isImageItem(item) {
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes((item?.extension || "").toLowerCase());
}

function isVideoItem(item) {
  return ["mp4", "m4v", "mov", "webm"].includes((item?.extension || "").toLowerCase());
}

function sortDirectoryItems(items) {
  return [...items].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "folder" ? -1 : 1;
    }

    return String(left.name || "").localeCompare(String(right.name || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function breadcrumbSegments(currentPath) {
  const trimmed = currentPath === "/" ? "" : currentPath.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return [{ label: "Root", path: "" }];
  }

  const segments = trimmed.split("/").filter(Boolean);
  const crumbs = [{ label: "Root", path: "" }];
  let cursor = "";

  for (const segment of segments) {
    cursor = cursor ? `${cursor}/${segment}` : segment;
    crumbs.push({ label: segment, path: cursor });
  }

  return crumbs;
}

function RowActions({ item, onOpen, onRename, onDelete }) {
  return (
    <div className="row-actions">
      {item.type === "folder" ? (
        <button className="ghost-button" type="button" onClick={onOpen}>
          Open
        </button>
      ) : (
        <button className="ghost-button" type="button" onClick={onOpen}>
          Preview
        </button>
      )}
      <button className="ghost-button" type="button" onClick={onRename}>
        Rename
      </button>
      <button className="ghost-button ghost-button--danger" type="button" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function GalleryCard({ item, onOpen }) {
  const previewUrl = item.type === "file" ? resolveUrl(`/preview?path=${encodeURIComponent(item.path)}`) : "";
  const cardType = item.type === "folder" ? "Folder" : humanFileType(item);

  return (
    <button className="gallery-card" type="button" onClick={onOpen}>
      <div className="gallery-thumb">
        {item.type === "folder" ? (
          <span className="gallery-thumb__icon">DIR</span>
        ) : isImageItem(item) ? (
          <img src={previewUrl} alt={item.name} loading="lazy" />
        ) : isVideoItem(item) ? (
          <>
            <video src={previewUrl} preload="metadata" muted playsInline />
            <span className="gallery-thumb__play">Play</span>
          </>
        ) : (
          <span className="gallery-thumb__icon">{cardType.slice(0, 3)}</span>
        )}
      </div>
      <div className="gallery-card__body">
        <strong>{item.name}</strong>
        <span>{item.displayPath}</span>
        <small>{item.type === "folder" ? "Folder" : `${cardType} · ${formatBytes(item.size)}`}</small>
      </div>
    </button>
  );
}

export default function DashboardPage() {
  const { email, signOut, refreshSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const uploadRef = useRef(null);
  const messageTimerRef = useRef(null);
  const uploadCompletionRef = useRef(false);
  const [directory, setDirectory] = useState({ items: [], currentPath: "/", parentPath: "/" });
  const [gallery, setGallery] = useState({ items: [] });
  const [storage, setStorage] = useState(null);
  const [systemStatus, setSystemStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileName, setUploadFileName] = useState("");
  const [uploadPhase, setUploadPhase] = useState("");
  const [uploadFileCount, setUploadFileCount] = useState(0);
  const [restoredUpload, setRestoredUpload] = useState(null);
  const [fastUploadMode, setFastUploadMode] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [previewTarget, setPreviewTarget] = useState(null);

  const crumbs = useMemo(() => breadcrumbSegments(directory.currentPath), [directory.currentPath]);
  const galleryItems = useMemo(() => gallery.items, [gallery.items]);

  async function loadData(path = "") {
    setLoading(true);
    setGalleryLoading(true);
    setError("");

    try {
      const [filesResponse, storageResponse, galleryResponse] = await Promise.all([
        request(`/files?path=${encodeURIComponent(path)}`),
        request("/storage"),
        request("/gallery"),
      ]);

      setDirectory(filesResponse);
      setStorage(storageResponse);
      setGallery(galleryResponse);
    } catch (requestError) {
      if (requestError.status === 401) {
        await refreshSession().catch(() => {});
        navigate("/login", { replace: true });
        return;
      }

      setError(requestError.message || "Unable to load files");
    } finally {
      setLoading(false);
      setGalleryLoading(false);
    }
  }

  async function loadSystemStatus() {
    try {
      const status = await request("/system-status");
      setSystemStatus(status);
    } catch {
      setSystemStatus(null);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const path = params.get("path") || "";
    loadData(path);
  }, [location.search]);

  useEffect(() => {
    loadSystemStatus();
    const interval = window.setInterval(() => {
      loadSystemStatus();
    }, 15000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const saved = readUploadSession();
    if (saved && saved.uploading) {
      setRestoredUpload(saved);
      setUploadProgress(saved.progress || 0);
      setUploadFileName(saved.fileName || "");
      setUploadPhase(saved.phase || "");
    }
  }, []);

  useEffect(() => {
    const savedMode = readUploadMode();
    setFastUploadMode(savedMode.fastUploadMode !== false);
  }, []);

  useEffect(() => {
    writeUploadMode({ fastUploadMode });
  }, [fastUploadMode]);

  useEffect(() => {
    if (!message) {
      return undefined;
    }

    if (messageTimerRef.current) {
      window.clearTimeout(messageTimerRef.current);
    }

    messageTimerRef.current = window.setTimeout(() => {
      setMessage("");
    }, 3500);

    return () => {
      if (messageTimerRef.current) {
        window.clearTimeout(messageTimerRef.current);
        messageTimerRef.current = null;
      }
    };
  }, [message]);

  useEffect(() => {
    if (!uploading) {
      return undefined;
    }

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [uploading]);

  useEffect(() => {
    if (uploading || uploadProgress > 0) {
      writeUploadSession({
        uploading,
        progress: uploadProgress,
        fileName: uploadFileName,
        phase: uploadPhase,
        path: directory.currentPath,
        updatedAt: Date.now(),
      });
      return;
    }

    clearUploadSession();
  }, [uploading, uploadProgress, uploadFileName, uploadPhase, directory.currentPath]);

  async function handleUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const uploadPath = directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, "");
    setUploading(true);
    setUploadProgress(0);
    setUploadFileCount(files.length);
    setUploadFileName(files.length > 1 ? `${files.length} files selected` : files[0].name);
    setUploadPhase("Uploading");
    setRestoredUpload(null);
    setError("");
    uploadCompletionRef.current = false;

    const formData = new FormData();
    formData.append("path", uploadPath);
    files.forEach((file) => formData.append("files", file));

    try {
      const result = await upload("/upload", {
        body: formData,
        fastUpload: fastUploadMode,
        onProgress: ({ progress, fileName, phase, chunkIndex, totalChunks }) => {
          setUploadProgress(Math.round(progress * 100));
          if (fileName) {
            setUploadFileName(
              files.length > 1
                ? `${fileName} (${Math.round(progress * 100)}% overall)`
                : fileName
            );
          }
          setUploadPhase(
            Number.isInteger(chunkIndex) && Number.isInteger(totalChunks)
              ? `${phase || "Uploading"} ${chunkIndex + 1}/${totalChunks}`
              : progress >= 0.995
                ? "Saving"
                : "Uploading"
          );
        },
      });

      if (result?.uploaded?.length) {
        appendItems(result.uploaded);
      }

      setMessage(
        files.length > 1
          ? `${result?.uploaded?.length || files.length} files uploaded successfully`
          : `${files[0].name} uploaded`
      );

      void loadData(uploadPath);
      void loadSystemStatus();
    } catch (requestError) {
      setError(requestError.message || "Upload failed");
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadFileName("");
      setUploadPhase("");
      setUploadFileCount(0);
      uploadCompletionRef.current = false;
      clearUploadSession();
      event.target.value = "";
    }
  }

  async function handleCreateFolder() {
    const name = folderName.trim();
    if (!name) {
      return;
    }

    setBusy(true);
    setError("");

    try {
      await request("/folders", {
        method: "POST",
        body: {
          path: directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, ""),
          name,
        },
      });
      setFolderName("");
      setFolderModalOpen(false);
      await loadData(directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, ""));
    } catch (requestError) {
      setError(requestError.message || "Unable to create folder");
    } finally {
      setBusy(false);
    }
  }

  async function handleRename() {
    if (!renameTarget || !renameValue.trim()) {
      return;
    }

    setBusy(true);
    setError("");

    try {
      await request("/files", {
        method: "PATCH",
        body: {
          path: renameTarget.path,
          newName: renameValue.trim(),
        },
      });
      setRenameTarget(null);
      setRenameValue("");
      await loadData(directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, ""));
    } catch (requestError) {
      setError(requestError.message || "Unable to rename item");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(item) {
    if (!window.confirm(`Delete ${item.name}?`)) {
      return;
    }

    setBusy(true);
    setError("");

    try {
      await request("/delete", {
        method: "DELETE",
        body: { path: item.path },
      });
      await loadData(directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, ""));
    } catch (requestError) {
      setError(requestError.message || "Unable to delete item");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await signOut();
    navigate("/login", { replace: true });
  }

  function openItem(item) {
    if (item.type === "folder") {
      openFolder(item.path);
      return;
    }

    setPreviewTarget(item);
  }

  function openFolder(path) {
    const nextPath = path || "";
    navigate(nextPath ? `/app?path=${encodeURIComponent(nextPath)}` : "/app", { replace: true });
  }

  function appendItems(items) {
    setDirectory((current) => {
      const currentItems = Array.isArray(current.items) ? current.items : [];
      const incoming = items
        .filter((item) => item?.path && !String(item.path).endsWith(".partial"))
        .map((item) => ({
          ...item,
          displayPath: item.path,
          type: item.type || "file",
          extension: item.extension || "",
          modifiedAt: item.modifiedAt || new Date().toISOString(),
          createdAt: item.createdAt || new Date().toISOString(),
          size: Number(item.size || 0),
        }));
      const merged = sortDirectoryItems([
        ...incoming.filter((item) => !currentItems.some((existing) => existing.path === item.path)),
        ...currentItems,
      ]);

      return {
        ...current,
        items: merged,
      };
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand-badge brand-badge--compact">Phone Cloud</div>
          <h1 className="sidebar-title">Drive-like personal cloud storage</h1>
          <p className="sidebar-copy">
            Single-user admin access, secure cookie auth, and direct filesystem management from your storage root.
          </p>
        </div>

        <div className="sidebar-meta">
          <span>Signed in as</span>
          <strong>{email || "Admin"}</strong>
        </div>

        <button className="secondary-button" type="button" onClick={handleLogout}>
          Logout
        </button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Phone Cloud</p>
            <h2>Storage dashboard</h2>
          </div>
          <div className="toolbar">
            <button className="secondary-button" type="button" onClick={() => setFolderModalOpen(true)} disabled={busy}>
              New folder
            </button>
            <button
              className={`toggle-button ${fastUploadMode ? "toggle-button--active" : ""}`}
              type="button"
              onClick={() => setFastUploadMode((current) => !current)}
              disabled={busy || uploading}
              aria-pressed={fastUploadMode}
              title={fastUploadMode ? "Fast upload mode on" : "Live preview mode on"}
            >
              {fastUploadMode ? "Fast upload" : "Live preview"}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => uploadRef.current?.click()}
              disabled={busy || uploading}
            >
              {uploading
                ? uploadFileCount > 1
                  ? `Uploading ${uploadFileCount} files...`
                  : "Uploading..."
                : "Upload files"}
            </button>
            <input ref={uploadRef} className="hidden-input" type="file" multiple onChange={handleUpload} />
          </div>
        </header>

        <StoragePanel storage={storage} systemStatus={systemStatus} />

        {uploading ? (
          <section className="upload-panel" aria-live="polite">
            <div className="upload-panel__header">
              <span>
                {uploadFileName
                  ? `${uploadPhase || "Uploading"}: ${uploadFileName}`
                  : uploadPhase || "Uploading files"}
              </span>
              <strong>{uploadProgress}%</strong>
            </div>
            <p className="upload-panel__copy">
              {uploadFileCount > 1
                ? `Uploading ${uploadFileCount} files — ${fastUploadMode ? "fast upload mode on" : "live preview mode on"}`
                : fastUploadMode
                  ? "Fast upload mode is on. HLS/extra preview work is skipped until after upload."
                  : "Live preview mode is on. Upload may be slower because the server keeps preview support active."}
            </p>
            <div className="progress-track">
              <div
                className="progress-fill progress-fill--upload"
                style={{ width: `${uploadProgress}%`, transition: "width 0.3s ease" }}
              />
            </div>
          </section>
        ) : restoredUpload ? (
          <section className="upload-panel" aria-live="polite">
            <div className="upload-panel__header">
              <span>
                {restoredUpload.fileName
                  ? `Upload interrupted: ${restoredUpload.fileName}`
                  : "Upload interrupted"}
              </span>
              <strong>{restoredUpload.progress || 0}%</strong>
            </div>
            <p className="upload-panel__copy">Refresh stops the browser upload. Re-select the file to continue.</p>
            <div className="progress-track">
              <div
                className="progress-fill progress-fill--upload"
                style={{ width: `${restoredUpload.progress || 0}%` }}
              />
            </div>
          </section>
        ) : null}

        <section className={`gallery-panel ${galleryOpen ? "gallery-panel--open" : ""}`}>
          <div className="gallery-panel__header">
            <div>
              <p className="eyebrow">Gallery</p>
              <h2>Open everything with thumbnails</h2>
            </div>
            <button className="secondary-button" type="button" onClick={() => setGalleryOpen((current) => !current)}>
              {galleryOpen ? "Hide gallery" : `Open gallery (${gallery.items.length})`}
            </button>
          </div>

          {galleryOpen ? (
            galleryLoading ? (
              <div className="empty-state">Loading gallery...</div>
            ) : galleryItems.length === 0 ? (
              <div className="empty-state">No gallery items yet.</div>
            ) : (
              <div className="gallery-grid">
                {galleryItems.map((item) => (
                  <GalleryCard key={item.path} item={item} onOpen={() => openItem(item)} />
                ))}
              </div>
            )
          ) : null}
        </section>

        <section className="directory-panel">
          <div className="directory-panel__header">
            <div>
              <p className="eyebrow">Files</p>
              <h2>Browse folders and files</h2>
            </div>
            <div className="breadcrumb">
              {crumbs.map((crumb, index) => (
                <button
                  key={`${crumb.path}-${index}`}
                  className={`breadcrumb__item ${index === crumbs.length - 1 ? "breadcrumb__item--active" : ""}`}
                  type="button"
                  onClick={() => openFolder(crumb.path)}
                >
                  {crumb.label}
                </button>
              ))}
            </div>
          </div>

          {message ? <div className="success-banner">{message}</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}

          {loading ? (
            <div className="empty-state">Loading files...</div>
          ) : directory.items.length === 0 ? (
            <div className="empty-state">This folder is empty.</div>
          ) : (
            <div className="file-table">
              <div className="file-table__head">
                <span>Name</span>
                <span>Type</span>
                <span>Size</span>
                <span>Updated</span>
                <span>Actions</span>
              </div>
              {directory.items.map((item) => (
                <article className="file-row" key={item.path}>
                  <button className="file-name" type="button" onClick={() => openItem(item)}>
                    <div className={`file-icon file-icon--${item.type}`}>
                      {item.type === "folder" ? "DIR" : humanFileType(item).slice(0, 3)}
                    </div>
                    <div>
                      <strong>{item.name}</strong>
                      <span>{item.displayPath}</span>
                    </div>
                  </button>
                  <span className="file-type">{humanFileType(item)}</span>
                  <span>{item.type === "folder" ? "-" : formatBytes(item.size)}</span>
                  <span>{formatDate(item.modifiedAt)}</span>
                  <RowActions
                    item={item}
                    onOpen={() => openItem(item)}
                    onRename={() => {
                      setRenameTarget(item);
                      setRenameValue(item.name);
                    }}
                    onDelete={() => handleDelete(item)}
                  />
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      {folderModalOpen ? (
        <Modal
          title="Create folder"
          description="Add a new folder in the current directory"
          value={folderName}
          setValue={setFolderName}
          onConfirm={handleCreateFolder}
          onClose={() => setFolderModalOpen(false)}
          confirmLabel="Create"
        />
      ) : null}

      {renameTarget ? (
        <Modal
          title="Rename item"
          description={`Rename ${renameTarget.name}`}
          value={renameValue}
          setValue={setRenameValue}
          onConfirm={handleRename}
          onClose={() => setRenameTarget(null)}
          confirmLabel="Rename"
        />
      ) : null}

      {previewTarget ? <FilePreviewModal item={previewTarget} onClose={() => setPreviewTarget(null)} /> : null}
    </div>
  );
}
