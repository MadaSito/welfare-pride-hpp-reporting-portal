// Robust fetch wrapper: friendly network-error messages, non-JSON handling,
// and CSRF header pass-through.
export interface ApiFetchOptions extends RequestInit {
  csrf?: string | null;
}

export async function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { csrf, headers, ...rest } = options;
  const mergedHeaders: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((v, k) => (mergedHeaders[k] = v));
  } else if (headers && !Array.isArray(headers)) {
    Object.assign(mergedHeaders, headers);
  }
  if (csrf) mergedHeaders["x-csrf-token"] = csrf;
  try {
    return await fetch(url, { ...rest, headers: mergedHeaders });
  } catch (err) {
    if (err instanceof TypeError && /failed to fetch/i.test(String(err))) {
      throw new Error("Could not reach the server. Please check your connection and that the site is online, then try again.");
    }
    throw err;
  }
}

export async function apiJson<T = any>(url: string, options: ApiFetchOptions = {}): Promise<T> {
  const res = await apiFetch(url, options);
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      res.ok
        ? "Unexpected response from server."
        : `Server returned ${res.status} (${res.statusText || "error"}).`
    );
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Request failed (${res.status}).`);
  }
  return data as T;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}
