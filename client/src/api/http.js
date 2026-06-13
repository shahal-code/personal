function normalizeError(message, status, details) {
  const error = new Error(message || "Request failed");
  error.status = status;
  error.details = details;
  return error;
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

function buildUrl(path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  if (!API_BASE_URL) {
    return path;
  }

  return `${API_BASE_URL}${path}`;
}

function getDownloadName(response, fallbackName) {
  const contentDisposition = response.headers.get("content-disposition") || "";
  const match = contentDisposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const encodedName = match?.[1];
  const plainName = match?.[2];

  if (encodedName) {
    try {
      return decodeURIComponent(encodedName);
    } catch {
      return encodedName;
    }
  }

  if (plainName) {
    return plainName;
  }

  return fallbackName;
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json")
    ? response.json().catch(() => ({}))
    : response.text().catch(() => "");
}

export async function request(path, options = {}) {
  const { method = "GET", body, headers = {}, signal } = options;
  const init = {
    method,
    credentials: "include",
    headers: {
      ...headers,
    },
    signal,
  };

  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(buildUrl(path), init);
  const payload = await parseResponse(response);

  if (!response.ok) {
    const message =
      typeof payload === "string"
        ? payload
        : payload?.message || payload?.error || response.statusText;
    throw normalizeError(message, response.status, payload);
  }

  return payload;
}

export async function upload(path, options = {}) {
  const { body, headers = {}, signal, onProgress } = options;

  if (!(body instanceof FormData)) {
    return request(path, options);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", buildUrl(path), true);
    xhr.withCredentials = true;

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject(normalizeError("Upload cancelled", 0));
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          xhr.abort();
          reject(normalizeError("Upload cancelled", 0));
        },
        { once: true }
      );
    }

    Object.entries(headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value);
    });

    xhr.upload.onprogress = (event) => {
      if (typeof onProgress === "function" && event.lengthComputable) {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          progress: event.total > 0 ? event.loaded / event.total : 0,
        });
      }
    };

    xhr.onload = async () => {
      const contentType = xhr.getResponseHeader("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await new Response(xhr.responseText).json().catch(() => ({}))
        : xhr.responseText;

      if (xhr.status < 200 || xhr.status >= 300) {
        const message =
          typeof payload === "string"
            ? payload
            : payload?.message || payload?.error || xhr.statusText || "Upload failed";
        reject(normalizeError(message, xhr.status, payload));
        return;
      }

      resolve(payload);
    };

    xhr.onerror = () => {
      reject(normalizeError("Upload failed", xhr.status || 0));
    };

    xhr.onabort = () => {
      reject(normalizeError("Upload cancelled", xhr.status || 0));
    };

    xhr.send(body);
  });
}

export async function download(path, fallbackName) {
  const response = await fetch(buildUrl(path), {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => "");
    const message =
      typeof payload === "string"
        ? payload
        : payload?.message || payload?.error || response.statusText;
    throw normalizeError(message, response.status, payload);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = getDownloadName(response, fallbackName || "download");
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function fetchBlob(path) {
  const response = await fetch(buildUrl(path), {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    const payload = await parseResponse(response);
    const message =
      typeof payload === "string"
        ? payload
        : payload?.message || payload?.error || response.statusText;
    throw normalizeError(message, response.status, payload);
  }

  return response.blob();
}

export async function fetchText(path) {
  const response = await fetch(buildUrl(path), {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    const payload = await parseResponse(response);
    const message =
      typeof payload === "string"
        ? payload
        : payload?.message || payload?.error || response.statusText;
    throw normalizeError(message, response.status, payload);
  }

  return response.text();
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = bytes;
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  const precision = current >= 10 || unitIndex === 0 ? 0 : 1;
  return `${current.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "N/A";
  }

  return `${Math.max(0, Math.min(100, Math.round(number)))}%`;
}

export function formatTemperature(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "N/A";
  }

  return `${number.toFixed(number >= 10 ? 0 : 1)}°C`;
}

export function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
