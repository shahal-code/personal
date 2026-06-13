export function notFoundHandler(req, res) {
  res.status(404).json({ message: "Route not found" });
}

export function errorHandler(err, req, res, next) {
  if (err?.code === "ECONNABORTED" || err?.type === "request.aborted") {
    return res.status(499).json({ message: "Request aborted" });
  }

  console.error(err);
  const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = status === 500 ? "Internal server error" : err.message || "Request failed";
  res.status(status).json({ message });
}
