/**
 * LibreTranslate-compatible runtime translation (optional).
 * Set LIBRETRANSLATE_URL to your instance base (e.g. http://localhost:5001).
 * When unset or unreachable, returns graceful passthrough (original text).
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.TRANSLATION_TIMEOUT_MS || 8000);
const MAX_CHARS = Number(process.env.TRANSLATION_MAX_CHARS || 4000);
const MAX_CACHE_ENTRIES = Number(process.env.TRANSLATION_CACHE_MAX || 600);

/** @type {Map<string, { value: object, t: number }>} */
const cache = new Map();

function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function cacheKey(text, target) {
  return `${target}:${djb2(text)}:${text.length}`;
}

function evictIfNeeded() {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

/** Rough script hint for passthrough when target already matches. */
function scriptHint(text) {
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) {
    return "ur";
  }
  return "en";
}

function normalizeTarget(t) {
  return t === "ur" ? "ur" : "en";
}

function sanitizeText(text) {
  const s = String(text ?? "")
    .replace(/\0/g, "")
    .trim();
  if (s.length > MAX_CHARS) {
    return { ok: false, error: "Text too long" };
  }
  return { ok: true, value: s };
}

async function callLibreTranslate(text, source, target) {
  const base = String(process.env.LIBRETRANSLATE_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (!base) return null;

  const url = `${base}/translate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: text,
        source: source || "auto",
        target,
        format: "text"
      }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const body = await res.json();
    const out = body?.translatedText ?? body?.translated ?? null;
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} text
 * @param {{ target: 'en'|'ur' }} opts
 */
async function translateRuntime(text, opts) {
  const target = normalizeTarget(opts?.target);
  const sanitized = sanitizeText(text);
  if (!sanitized.ok) {
    return {
      original: String(text ?? "").slice(0, MAX_CHARS),
      translated: String(text ?? "").slice(0, MAX_CHARS),
      sourceLang: "unknown",
      targetLang: target,
      cached: false,
      passthrough: true,
      error: sanitized.error
    };
  }
  const raw = sanitized.value;
  if (!raw) {
    return {
      original: "",
      translated: "",
      sourceLang: "unknown",
      targetLang: target,
      cached: false,
      passthrough: true
    };
  }

  const hint = scriptHint(raw);
  if (hint === target) {
    return {
      original: raw,
      translated: raw,
      sourceLang: hint,
      targetLang: target,
      cached: false,
      passthrough: true
    };
  }

  const ck = cacheKey(raw, target);
  const hit = cache.get(ck);
  if (hit) {
    return { ...hit.value, cached: true };
  }

  const libreOut = await callLibreTranslate(raw, "auto", target);
  const translated = libreOut != null && libreOut !== raw ? libreOut : raw;
  const resolvedSource = libreOut != null ? (hint === "ur" ? "ur" : "en") : hint;

  const payload = {
    original: raw,
    translated,
    sourceLang: resolvedSource,
    targetLang: target,
    cached: false,
    passthrough: libreOut == null
  };

  cache.set(ck, { value: payload, t: Date.now() });
  evictIfNeeded();

  return payload;
}

module.exports = {
  translateRuntime,
  sanitizeText,
  MAX_CHARS
};
