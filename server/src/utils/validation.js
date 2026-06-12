export function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isValidInteger(value) {
  const number = Number(value);
  return Number.isInteger(number);
}

export function parseJsonBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

export function parseRelativePath(input) {
  if (typeof input !== "string") {
    return "";
  }

  return input.trim();
}
