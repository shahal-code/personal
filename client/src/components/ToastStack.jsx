export default function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <button
          className={`toast toast--${toast.type || "info"}`}
          type="button"
          key={toast.id}
          onClick={() => onDismiss(toast.id)}
        >
          <strong>{toast.type === "error" ? "Error" : "Done"}</strong>
          <span>{toast.message}</span>
        </button>
      ))}
    </div>
  );
}
