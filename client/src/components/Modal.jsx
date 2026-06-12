export default function Modal({ title, description, value, setValue, onConfirm, onClose, confirmLabel }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">{title}</p>
            <h3>{description}</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <input
          className="text-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Enter a name"
          autoFocus
        />
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
