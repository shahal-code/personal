import { formatBytes, formatDate } from "../api/http.js";

export function FileActionModal({ item, favorite, onClose, onPreview, onDetails, onFavorite, onRename, onTransfer, onDelete }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal-card action-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><p className="eyebrow">File actions</p><h3>{item.name}</h3></div>
          <button className="icon-button" type="button" onClick={onClose}>Close</button>
        </div>
        <div className="action-grid">
          <button type="button" onClick={onPreview}>{item.type === "folder" ? "Open" : "Preview"}</button>
          <button type="button" onClick={onDetails}>Details</button>
          <button type="button" onClick={onFavorite}>{favorite ? "Remove favorite" : "Add favorite"}</button>
          <button type="button" onClick={onRename}>Rename</button>
          <button type="button" onClick={onTransfer}>Move or copy</button>
          <button className="action-grid__danger" type="button" onClick={onDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export function FileDetailsModal({ item, details, onClose }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><p className="eyebrow">Details</p><h3>{item.name}</h3></div>
          <button className="icon-button" type="button" onClick={onClose}>Close</button>
        </div>
        <dl className="details-list">
          <div><dt>Type</dt><dd>{details?.type || item.type}</dd></div>
          <div><dt>Size</dt><dd>{item.type === "folder" ? "-" : formatBytes(details?.size ?? item.size)}</dd></div>
          <div><dt>Location</dt><dd>{item.displayPath || item.path}</dd></div>
          <div><dt>Extension</dt><dd>{details?.extension || item.extension || "-"}</dd></div>
          <div><dt>Created</dt><dd>{formatDate(details?.createdAt || item.createdAt)}</dd></div>
          <div><dt>Modified</dt><dd>{formatDate(details?.updatedAt || item.modifiedAt)}</dd></div>
        </dl>
      </div>
    </div>
  );
}

export function TransferModal({ item, roots, busy, onClose, onConfirm }) {
  const activeRootId = roots?.activeRootId || "internal";
  const destinations = (roots?.options || []).filter((root) => root.available);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <form
        className="modal-card"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onConfirm({ operation: data.get("operation"), destinationRootId: data.get("destinationRootId"), destinationPath: data.get("destinationPath") });
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div><p className="eyebrow">Move or copy</p><h3>{item.name}</h3></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy}>Close</button>
        </div>
        <label className="field">Action<select className="text-input" name="operation" defaultValue="copy"><option value="copy">Copy</option><option value="move">Move</option></select></label>
        <label className="field">Destination storage<select className="text-input" name="destinationRootId" defaultValue={destinations.find((root) => root.id !== activeRootId)?.id || activeRootId}>{destinations.map((root) => <option value={root.id} key={root.id}>{root.label}</option>)}</select></label>
        <label className="field">Destination folder<input className="text-input" name="destinationPath" placeholder="Leave empty for root" /></label>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Working..." : "Continue"}</button>
        </div>
      </form>
    </div>
  );
}
