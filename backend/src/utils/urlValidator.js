/**
 * URL Validator
 *
 * Validates absolute http(s) URLs without any native dependency.
 */

const MAX_URL_LENGTH = 2048;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validateUrl(value) {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (!url || url.length > MAX_URL_LENGTH) return false;

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (!parsed.hostname || !parsed.hostname.includes(".")) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { validateUrl };
