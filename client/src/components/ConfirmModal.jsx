import { useEffect } from "react";

export default function ConfirmModal({ title, description, confirmLabel, busy, onConfirm, onClose }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape" && !busy) onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal-card modal-card--confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow eyebrow--danger">Confirm deletion</p>
            <h3 id="confirm-modal-title">{title}</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        <p id="confirm-modal-description" className="confirm-modal__description">
          {description}
        </p>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="danger-button" type="button" onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? "Deleting..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
