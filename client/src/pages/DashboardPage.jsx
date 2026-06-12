import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { request, formatBytes, formatDate } from "../api/http.js";
import { useAuth } from "../context/AuthContext.jsx";
import StoragePanel from "../components/StoragePanel.jsx";
import Modal from "../components/Modal.jsx";

function humanFileType(item) {
  if (item.type === "folder") {
    return "Folder";
  }

  const extension = item.extension || "file";
  return extension.toUpperCase();
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

function RowActions({ item, onOpen, onRename, onDelete, onDownload }) {
  return (
    <div className="row-actions">
      {item.type === "folder" ? (
        <button className="ghost-button" type="button" onClick={onOpen}>
          Open
        </button>
      ) : (
        <button className="ghost-button" type="button" onClick={onDownload}>
          Download
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

export default function DashboardPage() {
  const { email, signOut, refreshSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const uploadRef = useRef(null);
  const [directory, setDirectory] = useState({ items: [], currentPath: "/", parentPath: "/" });
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderName, setFolderName] = useState("");

  const crumbs = useMemo(() => breadcrumbSegments(directory.currentPath), [directory.currentPath]);

  async function loadData(path = "") {
    setLoading(true);
    setError("");

    try {
      const [filesResponse, storageResponse] = await Promise.all([
        request(`/files?path=${encodeURIComponent(path)}`),
        request("/storage"),
      ]);

      setDirectory(filesResponse);
      setStorage(storageResponse);
    } catch (requestError) {
      if (requestError.status === 401) {
        await refreshSession().catch(() => {});
        navigate("/login", { replace: true });
        return;
      }

      setError(requestError.message || "Unable to load files");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const path = params.get("path") || "";
    loadData(path);
  }, [location.search]);

  async function handleUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) {
      return;
    }

    setBusy(true);
    setError("");
    const formData = new FormData();
    formData.append("path", directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, ""));
    files.forEach((file) => formData.append("files", file));

    try {
      await request("/upload", { method: "POST", body: formData });
      await loadData(directory.currentPath === "/" ? "" : directory.currentPath.replace(/^\/+/, ""));
      setMessage(`${files.length} file${files.length > 1 ? "s" : ""} uploaded`);
    } catch (requestError) {
      setError(requestError.message || "Upload failed");
    } finally {
      setBusy(false);
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

  function openFolder(path) {
    const nextPath = path || "";
    navigate(nextPath ? `/app?path=${encodeURIComponent(nextPath)}` : "/app", { replace: true });
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
            <button className="primary-button" type="button" onClick={() => uploadRef.current?.click()} disabled={busy}>
              Upload files
            </button>
            <input ref={uploadRef} className="hidden-input" type="file" multiple onChange={handleUpload} />
          </div>
        </header>

        <StoragePanel storage={storage} />

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
                  <button className="file-name" type="button" onClick={() => item.type === "folder" && openFolder(item.path)}>
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
                    onOpen={() => openFolder(item.path)}
                    onRename={() => {
                      setRenameTarget(item);
                      setRenameValue(item.name);
                    }}
                    onDelete={() => handleDelete(item)}
                    onDownload={() => {
                      window.location.href = `/download?path=${encodeURIComponent(item.path)}`;
                    }}
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
    </div>
  );
}
