export const CONFIG = {
  coaZipLayer:
    "https://maps.austintexas.gov/arcgis/rest/services/Shared/BoundariesGrids_1/MapServer/5",
  parcelsLayer:
    "https://taxmaps.traviscountytx.gov/arcgis/rest/services/Parcels/MapServer/0",
};

export async function fetchJSON(url: string, body?: Record<string, any>, signal?: AbortSignal) {
  // In dev, route ArcGIS hosts through Vite proxy to avoid CORS.
  if (typeof location !== "undefined" && location.hostname === "localhost") {
    if (url.includes("taxmaps.traviscountytx.gov")) url = url.replace("https://taxmaps.traviscountytx.gov", "/proxy/taxmaps");
    if (url.includes("maps.austintexas.gov")) url = url.replace("https://maps.austintexas.gov", "/proxy/austin");
  }
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(
          Object.fromEntries(
            Object.entries(body).map(([k, v]) => [
              k,
              typeof v === "object" ? JSON.stringify(v) : String(v),
            ])
          ) as any
        ),
        signal,
      }
    : { method: "GET", signal };
  const res = await fetch(url + (body ? "" : (url.includes("?") ? "&" : "?") + "f=json"), opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.error) throw new Error(json.error?.message || json.error || "ArcGIS error");
  return json;
}

export async function fetchJSONWithRetry(
  url: string,
  body: Record<string, any> | undefined,
  signal: AbortSignal | undefined,
  { retries = 4, baseDelayMs = 550 }: { retries?: number; baseDelayMs?: number } = {}
) {
  let attempt = 0;
  while (true) {
    try {
      return await fetchJSON(url, body, signal);
    } catch (e: any) {
      const retriable = /HTTP (429|5\d\d)/.test(String(e?.message || e));
      if (!retriable || attempt >= retries || signal?.aborted) throw e;
      const delay = Math.round(baseDelayMs * Math.pow(1.7, attempt) * (0.7 + Math.random() * 0.6));
      await new Promise<void>((r, j) => {
        const id = setTimeout(r, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(id);
          j(new DOMException("Aborted", "AbortError"));
        });
      });
      attempt++;
    }
  }
}
