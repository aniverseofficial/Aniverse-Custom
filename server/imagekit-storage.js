const API = 'https://api.imagekit.io/v1';
const UPLOAD_API = 'https://upload.imagekit.io/api/v1/files/upload';

const privateKey = () => String(process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
const publicKey = () => String(process.env.IMAGEKIT_PUBLIC_KEY || '').trim();
const endpoint = () => String(process.env.IMAGEKIT_URL_ENDPOINT || '').replace(/\/$/, '');

export function imageKitConfigured() {
  return Boolean(privateKey() && publicKey() && endpoint());
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${privateKey()}:`).toString('base64');
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: authHeader(),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : (data?.message || data?.error || response.statusText);
    throw new Error(`ImageKit API ${response.status}: ${detail}`);
  }
  return data;
}

function safeName(name) {
  const base = String(name || 'image').split(/[\\/]/).pop() || 'image';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'image';
}

export async function uploadBufferToImageKit(buffer, originalName, options = {}) {
  if (!imageKitConfigured()) throw new Error('ImageKit is not configured');
  const form = new FormData();
  form.append('file', new Blob([buffer]));
  form.append('fileName', safeName(originalName));
  form.append('useUniqueFileName', 'true');
  form.append('folder', String(options.folder || '/aniverse/products'));
  if (options.tags) form.append('tags', Array.isArray(options.tags) ? options.tags.join(',') : String(options.tags));
  return uploadForm(form);
}

export async function uploadUrlToImageKit(sourceUrl, fileName, options = {}) {
  if (!imageKitConfigured()) throw new Error('ImageKit is not configured');
  const form = new FormData();
  form.append('file', String(sourceUrl));
  form.append('fileName', safeName(fileName || 'supplier-image.jpg'));
  form.append('useUniqueFileName', 'true');
  form.append('folder', String(options.folder || '/aniverse/products'));
  if (options.tags) form.append('tags', Array.isArray(options.tags) ? options.tags.join(',') : String(options.tags));
  return uploadForm(form);
}

async function uploadForm(form) {
  // Server-side uploads use HTTP Basic Auth with the private key as username.
  // Do not mix this with client-side token/signature/publicKey authentication.
  const response = await fetch(UPLOAD_API, {
    method: 'POST',
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    body: form
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : (data?.message || data?.error || response.statusText);
    throw new Error(`ImageKit upload ${response.status}: ${detail}`);
  }
  return data;
}

export async function listImageKitFiles({ limit = 1000, skip = 0, path } = {}) {
  const qs = new URLSearchParams({ limit: String(Math.min(1000, Math.max(1, limit))), skip: String(Math.max(0, skip)) });
  if (path) qs.set('path', path);
  const data = await apiFetch(`${API}/files?${qs.toString()}`);
  return Array.isArray(data) ? data : [];
}

export async function deleteImageKitFile(fileId) {
  if (!fileId) return null;
  return apiFetch(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

export async function getImageKitUsage() {
  // Account usage is exposed by ImageKit's account-management APIs. Keep this endpoint
  // isolated so the admin dashboard can evolve with the account-usage response shape.
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const isoDate = d => d.toISOString().slice(0, 10);
  const qs = new URLSearchParams({ startDate: isoDate(from), endDate: isoDate(now) });
  try {
    return await apiFetch(`${API}/accounts/usage?${qs.toString()}`);
  } catch {
    return { available: false };
  }
}
