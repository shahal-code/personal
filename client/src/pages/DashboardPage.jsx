import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { request, upload, clearRememberedUploadSession, formatBytes, formatDate, resolveUrl } from "../api/http.js";
import { useAuth } from "../context/AuthContext.jsx";
import StoragePanel from "../components/StoragePanel.jsx";
import Modal from "../components/Modal.jsx";
import FilePreviewModal from "../components/FilePreviewModal.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import ToastStack from "../components/ToastStack.jsx";
import { FileActionModal, FileDetailsModal, TransferModal } from "../components/FileActionModal.jsx";
import TransferJobsPanel from "../components/TransferJobsPanel.jsx";

const UPLOAD_SESSION_KEY = "phonecloud.uploadSession";
const UPLOAD_MODE_KEY = "phonecloud.uploadMode";
const UPLOAD_HISTORY_KEY = "phonecloud.uploadHistory";
const FAVORITES_KEY = "phonecloud.favorites";

function readFavorites() {
  try {
    return JSON.parse(window.localStorage.getItem(FAVORITES_KEY) || "[]");
  } catch {
    return [];
  }
}

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

function readUploadHistory() {
  try {
    const raw = window.localStorage.getItem(UPLOAD_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeUploadHistory(history) {
  try {
    window.localStorage.setItem(UPLOAD_HISTORY_KEY, JSON.stringify(history.slice(0, 12)));
  } catch {
    // Ignore storage errors.
  }
}

function addUploadHistoryEntry(entry) {
  const nextHistory = [
    {
      id: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
      ...entry,
    },
    ...readUploadHistory(),
  ].slice(0, 12);
  writeUploadHistory(nextHistory);
  return nextHistory;
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

function fileExtension(name) {
  const lastDot = String(name || "").lastIndexOf(".");
  return lastDot >= 0 ? String(name).slice(lastDot + 1).toLowerCase() : "";
}

function galleryKind(item) {
  if (item.type === "folder") return "folders";
  if (isImageItem(item)) return "images";
  if (isVideoItem(item)) return "videos";
  return "documents";
}

function matchesQuery(item, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${item.name || ""} ${item.displayPath || ""} ${item.extension || ""}`.toLowerCase().includes(normalized);
}

function sortItems(items, sortMode) {
  return [...items].sort((left, right) => {
    if (sortMode === "largest") return Number(right.size || 0) - Number(left.size || 0);
    if (sortMode === "oldest") return new Date(left.modifiedAt || 0) - new Date(right.modifiedAt || 0);
    if (sortMode === "type") return humanFileType(left).localeCompare(humanFileType(right));
    if (sortMode === "name") return String(left.name || "").localeCompare(String(right.name || ""), undefined, { numeric: true, sensitivity: "base" });
    return new Date(right.modifiedAt || 0) - new Date(left.modifiedAt || 0);
  });
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "calculating";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.ceil(seconds % 60);
  return `${minutes}m ${rest}s`;
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

function RowActions({ item, onOpen, onMore, onRename, onDelete }) {
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
      <button className="ghost-button" type="button" onClick={onMore}>
        More
      </button>
      <button className="ghost-button ghost-button--danger" type="button" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

const GalleryCard = memo(function GalleryCard({ item, onOpen }) {
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
            <span className="gallery-thumb__icon gallery-thumb__icon--video">VID</span>
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
});

export default function DashboardPage() {
  const { email, signOut, refreshSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const uploadRef = useRef(null);
  const uploadAbortRef = useRef(null);
  const uploadFilesRef = useRef([]);
  const uploadPathRef = useRef("");
  const pauseRequestedRef = useRef(false);
  const messageTimerRef = useRef(null);
  const uploadCompletionRef = useRef(false);
  const completedTransferJobsRef = useRef(new Set());
  const uploadSessionRef = useRef(null);
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
  const [uploadLoadedBytes, setUploadLoadedBytes] = useState(0);
  const [uploadTotalBytes, setUploadTotalBytes] = useState(0);
  const [uploadStartedAt, setUploadStartedAt] = useState(0);
  const [uploadPaused, setUploadPaused] = useState(false);
  const [uploadHistory, setUploadHistory] = useState(() => readUploadHistory());
  const [restoredUpload, setRestoredUpload] = useState(null);
  const [fastUploadMode, setFastUploadMode] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [fileSort, setFileSort] = useState("newest");
  const [galleryQuery, setGalleryQuery] = useState("");
  const [galleryFilter, setGalleryFilter] = useState("all");
  const [gallerySort, setGallerySort] = useState("newest");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState([]);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [previewTarget, setPreviewTarget] = useState(null);
  const [uploadPreview, setUploadPreview] = useState(null);
  const [changingStorageRoot, setChangingStorageRoot] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [favorites, setFavorites] = useState(readFavorites);
  const [fileScope, setFileScope] = useState("all");
  const [viewMode, setViewMode] = useState("grid");
  const [actionTarget, setActionTarget] = useState(null);
  const [detailsTarget, setDetailsTarget] = useState(null);
  const [details, setDetails] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [uploadQueue, setUploadQueue] = useState([]);
  const [transferJobs, setTransferJobs] = useState([]);

  const crumbs = useMemo(() => breadcrumbSegments(directory.currentPath), [directory.currentPath]);
  const visibleDirectoryItems = useMemo(() => {
    const scoped = fileScope === "favorites"
      ? directory.items.filter((item) => favorites.includes(item.path))
      : fileScope === "recent"
        ? [...directory.items].sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0)).slice(0, 20)
        : directory.items;
    return sortItems(scoped.filter((item) => matchesQuery(item, fileQuery)), fileSort);
  }, [directory.items, favorites, fileQuery, fileScope, fileSort]);
  const galleryItems = useMemo(
    () =>
      sortItems(
        gallery.items.filter((item) => (galleryFilter === "all" ? true : galleryKind(item) === galleryFilter)).filter((item) => matchesQuery(item, galleryQuery)),
        gallerySort
      ),
    [gallery.items, galleryFilter, galleryQuery, gallerySort]
  );
  const galleryMedia = useMemo(() => galleryItems.filter((item) => isVideoItem(item) || isImageItem(item)), [galleryItems]);
  const previewMediaIndex = previewTarget && (isVideoItem(previewTarget) || isImageItem(previewTarget))
    ? galleryMedia.findIndex((item) => item.path === previewTarget.path)
    : -1;
  const uploadElapsedSeconds = uploadStartedAt ? (Date.now() - uploadStartedAt) / 1000 : 0;
  const uploadSpeed = uploadElapsedSeconds > 0 ? uploadLoadedBytes / uploadElapsedSeconds : 0;
  const uploadEta = uploadSpeed > 0 ? (uploadTotalBytes - uploadLoadedBytes) / uploadSpeed : 0;
  const selectedItems = useMemo(
    () => directory.items.filter((item) => selectedPaths.includes(item.path)),
    [directory.items, selectedPaths]
  );

  useEffect(() => {
    return () => {
      if (uploadPreview?.url) {
        URL.revokeObjectURL(uploadPreview.url);
      }
    };
  }, [uploadPreview?.url]);

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

  async function handleStorageRootChange(rootId) {
    setChangingStorageRoot(true);
    setError("");
    setPreviewTarget(null);

    try {
      await request("/storage/root", { method: "PUT", body: { rootId } });
      navigate("/app", { replace: true });
      await loadData("");
      setMessage("Storage location changed");
    } catch (requestError) {
      setError(requestError.message || "Unable to change storage location");
    } finally {
      setChangingStorageRoot(false);
    }
  }

  async function loadCpuStatus() {
    try {
      const cpu = await request("/cpu-status");
      setSystemStatus((current) => ({ ...(current || {}), cpu }));
    } catch {
      // Keep the most recent CPU reading when a live refresh fails.
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const path = params.get("path") || "";
    setSelectedPaths([]);
    setSelectionMode(false);
    loadData(path);
  }, [location.search]);

  useEffect(() => {
    loadSystemStatus();
    const interval = window.setInterval(loadSystemStatus, 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId = null;

    async function refreshCpu() {
      await loadCpuStatus();
      if (!cancelled) {
        timeoutId = window.setTimeout(refreshCpu, 2000);
      }
    }

    refreshCpu();
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
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
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    const text = error || message;
    if (!text) return;
    const toast = { id: crypto.randomUUID(), type: error ? "error" : "success", message: text };
    setToasts((current) => [...current.slice(-2), toast]);
    const timer = window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== toast.id)), 4000);
    return () => window.clearTimeout(timer);
  }, [error, message]);

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

    uploadFilesRef.current = files;
    uploadPathRef.current = directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, "");
    await runUpload(files, uploadPathRef.current, event.target);
  }

  async function runUpload(files, uploadPath, inputElement = null) {
    const uploadController = new AbortController();
    uploadAbortRef.current = uploadController;
    pauseRequestedRef.current = false;
    setUploading(true);
    setUploadPaused(false);
    setUploadProgress(0);
    setUploadLoadedBytes(0);
    setUploadTotalBytes(files.reduce((sum, file) => sum + Number(file.size || 0), 0));
    setUploadStartedAt(Date.now());
    setUploadFileCount(files.length);
    setUploadQueue(files.map((file) => ({ name: file.name, size: file.size, progress: 0, status: "queued" })));
    setUploadFileName(files.length > 1 ? `${files.length} files selected` : files[0].name);
    setUploadPhase("Uploading");
    setRestoredUpload(null);
    setError("");
    setUploadPreview((current) => {
      if (current?.url) URL.revokeObjectURL(current.url);
      const mediaFile = files.find((file) => {
        const extension = fileExtension(file.name);
        return ["mp4", "m4v", "mov", "webm", "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(extension);
      });
      if (!mediaFile) return null;
      const extension = fileExtension(mediaFile.name);
      const destinationPath = uploadPath ? `${uploadPath}/${mediaFile.name}` : mediaFile.name;
      return {
        url: URL.createObjectURL(mediaFile),
        item: {
          name: mediaFile.name,
          path: destinationPath,
          displayPath: `Local preview · /${destinationPath}`,
          type: "file",
          size: mediaFile.size,
          extension,
          modifiedAt: new Date(mediaFile.lastModified || Date.now()).toISOString(),
          createdAt: new Date().toISOString(),
        },
      };
    });
    uploadCompletionRef.current = false;

    const formData = new FormData();
    formData.append("path", uploadPath);
    files.forEach((file) => formData.append("files", file));

    try {
      const result = await upload("/upload", {
        body: formData,
        fastUpload: fastUploadMode,
        signal: uploadController.signal,
        onUploadSession: (session) => {
          uploadSessionRef.current = session;
        },
        onProgress: ({ progress, fileName, phase, chunkIndex, totalChunks, loaded, total }) => {
          setUploadProgress(Math.round(progress * 100));
          setUploadLoadedBytes(Number(loaded || 0));
          setUploadTotalBytes(Number(total || 0));
          setUploadQueue((current) => {
            let remaining = Number(loaded || 0);
            return current.map((entry) => {
              const completed = Math.min(entry.size, Math.max(0, remaining));
              remaining -= entry.size;
              return {
                ...entry,
                progress: entry.size > 0 ? Math.round((completed / entry.size) * 100) : 100,
                status: completed >= entry.size ? "completed" : completed > 0 ? "uploading" : "queued",
              };
            });
          });
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
      setUploadHistory(
        addUploadHistoryEntry({
          status: "completed",
          name: files.length > 1 ? `${files.length} files` : files[0].name,
          size: files.reduce((sum, file) => sum + Number(file.size || 0), 0),
          progress: 100,
        })
      );

      void loadData(uploadPath);
      void loadSystemStatus();
    } catch (requestError) {
      if (requestError.message === "Upload cancelled" && pauseRequestedRef.current) {
        setUploadPaused(true);
        setUploadPhase("Paused");
        setMessage("Upload paused");
      } else if (requestError.message === "Upload cancelled") {
        setMessage("Upload cancelled");
        setUploadHistory(
          addUploadHistoryEntry({
            status: "cancelled",
            name: files.length > 1 ? `${files.length} files` : files[0].name,
            size: files.reduce((sum, file) => sum + Number(file.size || 0), 0),
            progress: uploadProgress,
          })
        );
      } else {
        setError(requestError.message || "Upload failed");
        setUploadHistory(
          addUploadHistoryEntry({
            status: "failed",
            name: files.length > 1 ? `${files.length} files` : files[0].name,
            size: files.reduce((sum, file) => sum + Number(file.size || 0), 0),
            progress: uploadProgress,
          })
        );
      }
    } finally {
      if (uploadAbortRef.current === uploadController) {
        uploadAbortRef.current = null;
      }
      setUploading(false);
      if (!pauseRequestedRef.current) {
        uploadFilesRef.current = [];
        uploadPathRef.current = "";
        setUploadProgress(0);
        setUploadLoadedBytes(0);
        setUploadTotalBytes(0);
        setUploadStartedAt(0);
        setUploadFileName("");
        setUploadPhase("");
        setUploadFileCount(0);
        setUploadQueue([]);
        uploadCompletionRef.current = false;
        uploadSessionRef.current = null;
        clearUploadSession();
        if (inputElement) {
          inputElement.value = "";
        }
      }
    }
  }

  async function handleCancelUpload() {
    if (uploadPaused && !uploading) {
      const session = uploadSessionRef.current;
      if (session?.uploadId) {
        await request(`/upload/session/${encodeURIComponent(session.uploadId)}`, { method: "DELETE" }).catch(() => {});
        clearRememberedUploadSession(session.sessionKey);
        uploadSessionRef.current = null;
      }
      pauseRequestedRef.current = false;
      uploadFilesRef.current = [];
      uploadPathRef.current = "";
      setUploadPaused(false);
      setUploadProgress(0);
      setUploadLoadedBytes(0);
      setUploadTotalBytes(0);
      setUploadStartedAt(0);
      setUploadFileName("");
      setUploadPhase("");
      setUploadFileCount(0);
      setMessage("Upload cancelled");
      clearUploadSession();
      return;
    }

    pauseRequestedRef.current = false;
    uploadAbortRef.current?.abort();
    const session = uploadSessionRef.current;
    if (session?.uploadId) {
      window.setTimeout(() => {
        request(`/upload/session/${encodeURIComponent(session.uploadId)}`, { method: "DELETE" })
          .catch(() => {})
          .finally(() => {
            clearRememberedUploadSession(session.sessionKey);
            if (uploadSessionRef.current?.uploadId === session.uploadId) uploadSessionRef.current = null;
          });
      }, 300);
    }
  }

  function handlePauseUpload() {
    pauseRequestedRef.current = true;
    uploadAbortRef.current?.abort();
  }

  function handleResumeUpload() {
    if (uploadFilesRef.current.length === 0) {
      setError("Select the same file again to resume this upload");
      return;
    }

    void runUpload(uploadFilesRef.current, uploadPathRef.current);
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

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    setError("");

    try {
      for (const item of deleteTarget.items) {
        await request("/delete", {
          method: "DELETE",
          body: { path: item.path },
        });
      }
      setDeleteTarget(null);
      if (deleteTarget.kind === "bulk") {
        setSelectedPaths([]);
        setSelectionMode(false);
      }
      await loadData(directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, ""));
    } catch (requestError) {
      setError(requestError.message || "Unable to delete selected items");
    } finally {
      setBusy(false);
    }
  }

  function handleDelete(item) {
    setDeleteTarget({ kind: "single", items: [item] });
  }

  function toggleFavorite(item) {
    setFavorites((current) => current.includes(item.path) ? current.filter((path) => path !== item.path) : [...current, item.path]);
    setActionTarget(null);
  }

  async function showDetails(item) {
    setActionTarget(null);
    setDetailsTarget(item);
    setDetails(null);
    try {
      setDetails(await request(`/items?path=${encodeURIComponent(item.path)}`));
    } catch (requestError) {
      setError(requestError.message || "Unable to load file details");
    }
  }

  async function handleTransfer(payload) {
    setBusy(true);
    try {
      const response = await request("/transfer", {
        method: "POST",
        body: {
          ...payload,
          path: transferTarget.path,
          sourceRootId: storage?.roots?.activeRootId,
        },
      });
      setTransferTarget(null);
      setTransferJobs((current) => [response.job, ...current]);
      setMessage("Transfer queued and will continue in the background");
    } catch (requestError) {
      setError(requestError.message || "Unable to transfer item");
    } finally {
      setBusy(false);
    }
  }

  async function loadTransferJobs() {
    try {
      const payload = await request("/transfer/jobs?limit=20");
      const jobs = payload.jobs || [];
      setTransferJobs(jobs);
      const newlyCompleted = jobs.filter((job) => job.status === "completed" && !completedTransferJobsRef.current.has(job.id));
      jobs.filter((job) => job.status === "completed").forEach((job) => completedTransferJobsRef.current.add(job.id));
      if (newlyCompleted.length > 0) {
        void loadData(directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, ""));
      }
    } catch {
      // Keep the latest job state if polling fails.
    }
  }

  useEffect(() => {
    loadTransferJobs();
    const interval = window.setInterval(loadTransferJobs, 3000);
    return () => window.clearInterval(interval);
  }, []);

  function handleBulkDelete() {
    if (selectedItems.length > 0) {
      setDeleteTarget({ kind: "bulk", items: selectedItems });
    }
  }

  function toggleSelectedPath(path) {
    setSelectedPaths((current) => (current.includes(path) ? current.filter((itemPath) => itemPath !== path) : [...current, path]));
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
            <button className="secondary-button" type="button" onClick={() => navigate("/app/search")}>
              Global Search
            </button>
            <button className="secondary-button" type="button" onClick={() => navigate("/app/security")}>
              Security Activity
            </button>
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

        <div id="storage">
          <StoragePanel
            storage={storage}
            systemStatus={systemStatus}
            onStorageRootChange={handleStorageRootChange}
            changingStorageRoot={changingStorageRoot || uploading || uploadPaused}
            transferStatus={{
              activeUploads: uploading ? uploadFileCount : 0,
              uploadBytesPerSecond: uploading ? uploadSpeed : 0,
            }}
          />
        </div>

        {uploading || uploadPaused ? (
          <section className="upload-panel upload-panel--active" aria-live="polite">
            <div className="upload-panel__header">
              <span>
                {uploadFileName
                  ? `${uploadPhase || "Uploading"}: ${uploadFileName}`
                  : uploadPhase || "Uploading files"}
              </span>
              <div className="upload-panel__controls">
                <strong>{uploadProgress}%</strong>
                {uploadPreview?.item ? (
                  <button className="ghost-button" type="button" onClick={() => setPreviewTarget(uploadPreview.item)}>
                    Preview now
                  </button>
                ) : null}
                {uploadPaused ? (
                  <button className="ghost-button" type="button" onClick={handleResumeUpload}>
                    Resume
                  </button>
                ) : (
                  <button className="ghost-button" type="button" onClick={handlePauseUpload}>
                    Pause
                  </button>
                )}
                <button className="ghost-button ghost-button--danger" type="button" onClick={handleCancelUpload}>
                  Cancel
                </button>
              </div>
            </div>
            <p className="upload-panel__copy">
              {uploadFileCount > 1
                ? `Uploading ${uploadFileCount} files — ${fastUploadMode ? "fast upload mode on" : "live preview mode on"}`
                : fastUploadMode
                  ? "Fast upload mode is on. Upload uses maximum S3 parallelism."
                  : "Live preview mode is on. Upload leaves bandwidth for watching already uploaded videos."}
            </p>
            <div className="progress-track">
              <div
                className="progress-fill progress-fill--upload"
                style={{ width: `${uploadProgress}%`, transition: "width 0.3s ease" }}
              />
            </div>
            <p className="upload-panel__copy upload-panel__copy--metrics">
              {`${formatBytes(uploadLoadedBytes)} of ${formatBytes(uploadTotalBytes)} · ${formatBytes(uploadSpeed)}/s · ETA ${formatDuration(uploadEta)}`}
            </p>
            {uploadQueue.length > 1 ? (
              <div className="upload-queue">
                {uploadQueue.map((entry) => (
                  <div className="upload-queue__item" key={`${entry.name}-${entry.size}`}>
                    <span>{entry.name}</span>
                    <strong>{entry.progress}%</strong>
                  </div>
                ))}
              </div>
            ) : null}
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

        {uploadHistory.length > 0 ? (
          <section className="upload-history-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Uploads</p>
                <h2>Recent activity</h2>
              </div>
              <button
                className="ghost-button"
                type="button"
                onClick={() => {
                  writeUploadHistory([]);
                  setUploadHistory([]);
                }}
              >
                Clear history
              </button>
            </div>
            <div className="upload-history-list">
              {uploadHistory.slice(0, 5).map((entry) => (
                <article className={`upload-history-item upload-history-item--${entry.status}`} key={entry.id}>
                  <div>
                    <strong>{entry.name}</strong>
                    <span>{formatBytes(entry.size || 0)} · {formatDate(entry.updatedAt)}</span>
                  </div>
                  <span>{entry.status} · {entry.progress || 0}%</span>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <TransferJobsPanel jobs={transferJobs} />

        <section id="gallery" className={`gallery-panel ${galleryOpen ? "gallery-panel--open" : ""}`}>
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
            <>
              <div className="control-bar">
                <input
                  className="text-input control-input"
                  type="search"
                  value={galleryQuery}
                  onChange={(event) => setGalleryQuery(event.target.value)}
                  placeholder="Search gallery"
                />
                <select className="text-input control-select" value={galleryFilter} onChange={(event) => setGalleryFilter(event.target.value)}>
                  <option value="all">All items</option>
                  <option value="images">Images</option>
                  <option value="videos">Videos</option>
                  <option value="documents">Documents</option>
                  <option value="folders">Folders</option>
                </select>
                <select className="text-input control-select" value={gallerySort} onChange={(event) => setGallerySort(event.target.value)}>
                  <option value="newest">Newest first</option>
                  <option value="name">Name</option>
                  <option value="largest">Largest</option>
                  <option value="type">Type</option>
                </select>
              </div>
              {galleryLoading ? (
                <div className="skeleton-grid">
                  <span className="skeleton-card" />
                  <span className="skeleton-card" />
                  <span className="skeleton-card" />
                </div>
            ) : galleryItems.length === 0 ? (
              <div className="empty-state">No gallery items yet.</div>
            ) : (
              <div className="gallery-grid">
                {galleryItems.map((item) => (
                  <GalleryCard key={item.path} item={item} onOpen={() => openItem(item)} />
                ))}
              </div>
              )}
            </>
          ) : null}
        </section>

        <section id="files" className="directory-panel">
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

          <div className="control-bar">
            <input
              className="text-input control-input"
              type="search"
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="Search current folder"
            />
            <select className="text-input control-select" value={fileSort} onChange={(event) => setFileSort(event.target.value)}>
              <option value="newest">Newest first</option>
              <option value="name">Name</option>
              <option value="largest">Largest</option>
              <option value="type">Type</option>
            </select>
            <select className="text-input control-select" value={fileScope} onChange={(event) => setFileScope(event.target.value)}>
              <option value="all">All files</option>
              <option value="recent">Recent</option>
              <option value="favorites">Favorites</option>
            </select>
            <button className="toggle-button" type="button" onClick={() => setViewMode((current) => current === "grid" ? "list" : "grid")}>
              {viewMode === "grid" ? "List view" : "Grid view"}
            </button>
            <button
              className={`toggle-button ${selectionMode ? "toggle-button--active" : ""}`}
              type="button"
              onClick={() => {
                setSelectionMode((current) => !current);
                setSelectedPaths([]);
              }}
            >
              {selectionMode ? "Cancel select" : "Select files"}
            </button>
            {selectionMode && selectedItems.length > 0 ? (
              <button className="ghost-button ghost-button--danger" type="button" onClick={handleBulkDelete} disabled={busy}>
                Delete {selectedItems.length}
              </button>
            ) : null}
          </div>

          {loading ? (
            <div className="skeleton-list">
              <span />
              <span />
              <span />
            </div>
          ) : visibleDirectoryItems.length === 0 ? (
            <div className="empty-state empty-state--actions">
              <strong>{fileScope === "favorites" ? "No favorites here." : "This folder is empty."}</strong>
              <span>Upload files or create a folder to get started.</span>
              <div>
                <button className="primary-button" type="button" onClick={() => uploadRef.current?.click()}>Upload files</button>
                <button className="secondary-button" type="button" onClick={() => setFolderModalOpen(true)}>New folder</button>
              </div>
            </div>
          ) : (
            <div className={`file-table file-table--${viewMode} ${selectionMode ? "file-table--selecting" : ""}`}>
              <div className="file-table__head">
                {selectionMode ? <span>Select</span> : null}
                <span>Name</span>
                <span>Type</span>
                <span>Size</span>
                <span>Updated</span>
                <span>Actions</span>
              </div>
              {visibleDirectoryItems.map((item) => (
                <article
                  className={`file-row ${selectedPaths.includes(item.path) ? "file-row--selected" : ""}`}
                  key={item.path}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setActionTarget(item);
                  }}
                >
                  {selectionMode ? (
                    <label className="select-check">
                      <input
                        type="checkbox"
                        checked={selectedPaths.includes(item.path)}
                        onChange={() => toggleSelectedPath(item.path)}
                      />
                      <span>Select</span>
                    </label>
                  ) : null}
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
                    onMore={() => setActionTarget(item)}
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

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <a href="#storage">Storage</a>
        <a href="#gallery" onClick={() => setGalleryOpen(true)}>Gallery</a>
        <a href="#files">Files</a>
        <button type="button" onClick={() => navigate("/app/search")}>Search</button>
        <button type="button" onClick={() => navigate("/app/security")}>Security</button>
        <button type="button" onClick={() => uploadRef.current?.click()} disabled={busy || uploading}>
          Upload
        </button>
      </nav>

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

      {deleteTarget ? (
        <ConfirmModal
          title={deleteTarget.kind === "bulk" ? `Delete ${deleteTarget.items.length} items?` : `Delete ${deleteTarget.items[0].name}?`}
          description={
            deleteTarget.kind === "bulk"
              ? "These files and folders will be permanently deleted. This action cannot be undone."
              : `${deleteTarget.items[0].type === "folder" ? "This folder and everything inside it" : "This file"} will be permanently deleted. This action cannot be undone.`
          }
          confirmLabel={deleteTarget.kind === "bulk" ? `Delete ${deleteTarget.items.length} items` : "Delete"}
          busy={busy}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}

      {actionTarget ? (
        <FileActionModal
          item={actionTarget}
          favorite={favorites.includes(actionTarget.path)}
          onClose={() => setActionTarget(null)}
          onPreview={() => { setActionTarget(null); openItem(actionTarget); }}
          onDetails={() => showDetails(actionTarget)}
          onFavorite={() => toggleFavorite(actionTarget)}
          onRename={() => { setRenameTarget(actionTarget); setRenameValue(actionTarget.name); setActionTarget(null); }}
          onTransfer={() => { setTransferTarget(actionTarget); setActionTarget(null); }}
          onDelete={() => { handleDelete(actionTarget); setActionTarget(null); }}
        />
      ) : null}

      {detailsTarget ? (
        <FileDetailsModal item={detailsTarget} details={details} onClose={() => setDetailsTarget(null)} />
      ) : null}

      {transferTarget ? (
        <TransferModal
          item={transferTarget}
          roots={storage?.roots}
          busy={busy}
          onClose={() => setTransferTarget(null)}
          onConfirm={handleTransfer}
        />
      ) : null}

      <ToastStack
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />

      {previewTarget ? (
          <FilePreviewModal
            item={previewTarget}
          onClose={() => setPreviewTarget(null)}
          localPreviewUrl={uploadPreview?.item?.path === previewTarget.path ? uploadPreview.url : ""}
          hasPrevious={previewMediaIndex > 0}
          hasNext={previewMediaIndex >= 0 && previewMediaIndex < galleryMedia.length - 1}
          onPrevious={() => setPreviewTarget(galleryMedia[previewMediaIndex - 1])}
          onNext={() => setPreviewTarget(galleryMedia[previewMediaIndex + 1])}
        />
      ) : null}
    </div>
  );
}
