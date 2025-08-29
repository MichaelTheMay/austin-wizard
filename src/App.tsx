import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import "./app.css";

/**
 * Travis County ZIP + Owner Scraper Wizard (with Austin Geocoder)
 * ----------------------------------------------------------------
 * Export Center added:
 * - Batch export across multiple ZIPs (selected / filtered / custom).
 * - Owner-type filter (business / residential / both).
 * - Column selector; auto-prunes unavailable fields via layer metadata.
 * - Single file across all ZIPs OR one CSV per ZIP.
 * - Optional webhook streaming (NDJSON batches).
 * - Progress UI: totals, per-ZIP status, elapsed/ETA, cancel.
 * - Robust fetch with retry/backoff + polite throttling between pages.
 * - Reuses real server-side paging (resultOffset/resultRecordCount) per ZIP.
 *
 * Parcel modal retained with export-current-page as before.
 */

const CONFIG = {
  coaZipLayer:
    "https://maps.austintexas.gov/arcgis/rest/services/Shared/BoundariesGrids_1/MapServer/5",
  parcelsLayer:
    "https://taxmaps.traviscountytx.gov/arcgis/rest/services/Parcels/MapServer/0",
};

// ------------------------- fetch helpers -------------------------
async function fetchJSON(url: string, body?: Record<string, any>, signal?: AbortSignal) {
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
  const res = await fetch(
    url + (body ? "" : (url.includes("?") ? "&" : "?") + "f=json"),
    opts
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.error)
    throw new Error(json.error?.message || json.error || "ArcGIS error");
  return json;
}

// Retry wrapper with exponential backoff + jitter (429/5xx)
async function fetchJSONWithRetry(
  url: string,
  body: Record<string, any> | undefined,
  signal: AbortSignal | undefined,
  { retries = 5, baseDelayMs = 600 }: { retries?: number; baseDelayMs?: number } = {}
) {
  let attempt = 0;
  while (true) {
    try {
      return await fetchJSON(url, body, signal);
    } catch (e: any) {
      const retriable = /HTTP (429|5\d\d)/.test(String(e?.message || e));
      if (!retriable || attempt >= retries || signal?.aborted) throw e;
      const delay = Math.round(baseDelayMs * Math.pow(1.7, attempt) * (0.7 + Math.random() * 0.6));
      await sleep(delay, signal);
      attempt++;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const id = setTimeout(() => resolve(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

// ------------------------- utils -------------------------
function zip5(v: any): string | null {
  if (v == null) return null;
  const s = String(v);
  const only = s.replace(/\D/g, "");
  if (only.length < 5) return null;
  const five = only.slice(0, 5);
  return five.length === 5 ? five : null;
}

function cleanZip(zip: string): string | null {
  return zip5(zip);
}

function formatUSD(n: any) {
  const x = Number(n);
  if (!isFinite(x)) return "";
  try {
    return x.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  } catch {
    return `$${Math.round(x).toLocaleString()}`;
  }
}

function classifyOwner(name: string): "business" | "residential" {
  if (!name) return "residential";
  const u = name.toUpperCase();
  const bizTokens = [
    " LLC",
    "INC",
    " CORP",
    " CORPORATION",
    " LTD",
    " LP",
    " L.P",
    " LLP",
    " PLLC",
    " CO ",
    " COMPANY",
    " HOLDINGS",
    " HLDGS",
    " PARTNERS",
    " PARTNERSHIP",
    " TRUST",
    " TR",
    " INVESTMENTS",
    " PROPERTIES",
    " MGMT",
    " MANAGEMENT",
    " ENTERPRISE",
    " FOUNDATION",
  ];
  return bizTokens.some((t) => u.includes(t)) ? "business" : "residential";
}

// CSV builder that supports incremental appends (no giant in-memory array)
class CSVBuilder {
  headers: string[];
  headerLine: string;
  parts: string[] = [];
  constructor(headers: string[]) {
    this.headers = headers;
    this.headerLine = headers.join(",") + "\n";
    this.parts.push(this.headerLine);
  }
  static esc(v: any) {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }
  appendRows(objs: Record<string, any>[]) {
    if (!objs.length) return;
    const lines = objs.map((r) => this.headers.map((h) => CSVBuilder.esc(r[h])).join(",")).join("\n");
    this.parts.push(lines + "\n");
  }
  download(filename: string) {
    const blob = new Blob(this.parts, { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

// ------------------------- types -------------------------
type OwnerTab = "business" | "residential";
type OwnerScope = "both" | OwnerTab;

type ZipRow = { zip: string; count: number };

// ------------------------- main -------------------------
export default function App() {
  const [zips, setZips] = useState<ZipRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [sortByCount, setSortByCount] = useState(false);
  const [austinOnly, setAustinOnly] = useState(true);

  // Modal / parcels
  const [expandedZip, setExpandedZip] = useState<string | null>(null);
  const [parcelLoading, setParcelLoading] = useState(false);
  const [parcelError, setParcelError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<OwnerTab>("business");
  const [parcelFilter, setParcelFilter] = useState("");
  const [parcelSort, setParcelSort] = useState<{ key: string; dir: "asc" | "desc" }>(
    { key: "py_owner_name", dir: "asc" }
  );

  // Server-side paging state (parcel modal)
  const [page, setPage] = useState(1);
  const pageSize = 500;
  const [pageRows, setPageRows] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  // Dynamic field discovery for parcels layer
  const [availableFields, setAvailableFields] = useState<Set<string>>(new Set());
  const desiredFieldsBase = [
    "py_owner_name",
    "situs_address",
    "situs_zip",
    "PROP_ID",
    "geo_id",
    "land_type_desc",
    "tcad_acres",
    "market_value",
    "appraised_val",
    "assessed_val",
  ];

  // ------------------------------------------------------
  // Export Center state
  // ------------------------------------------------------
  const [exportOpen, setExportOpen] = useState(false);

  // Column defs (key -> label); we enrich with computed columns as options
  const ALL_LABELS: Record<string, string> = {
    py_owner_name: "Owner",
    situs_address: "Situs Address",
    situs_zip: "Situs ZIP (raw)",
    _zip5: "ZIP",
    PROP_ID: "Parcel ID",
    geo_id: "Geo ID",
    land_type_desc: "Land Type",
    tcad_acres: "Acres",
    market_value: "Market Value",
    appraised_val: "Appraised",
    assessed_val: "Assessed",
    _owner_type: "Owner Type",
  };

  // Export options
  const [exportScope, setExportScope] = useState<"selected" | "filtered" | "custom">("selected");
  const [customZipInput, setCustomZipInput] = useState("");
  const [ownerScope, setOwnerScope] = useState<OwnerScope>("both");
  const [exportMode, setExportMode] = useState<"single" | "perZip">("single");
  const [filePrefix, setFilePrefix] = useState("parcels");
  const [throttleMs, setThrottleMs] = useState(200); // pause between page fetches
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookBatchSize, setWebhookBatchSize] = useState(500); // rows per POST
  const [selectedFields, setSelectedFields] = useState<string[]>([
    "py_owner_name",
    "situs_address",
    "_zip5",
    "PROP_ID",
    "geo_id",
    "land_type_desc",
    "tcad_acres",
    "market_value",
    "appraised_val",
    "assessed_val",
  ]);

  // Export progress
  const [exportRunning, setExportRunning] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportLog, setExportLog] = useState<string[]>([]);
  const [exportTotalRows, setExportTotalRows] = useState(0);
  const [exportTotalExpected, setExportTotalExpected] = useState<number | null>(null);
  const [perZipProgress, setPerZipProgress] = useState<Record<string, { done: number; total: number }>>({});
  const abortRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef<number>(0);

  const appendLog = useCallback((line: string) => {
    setExportLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${line}`].slice(-500));
  }, []);

  // ---- bootstrap: fields + zip list + stats ----
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError(null);

        // Discover fields on parcels layer so we only request what exists
        try {
          const meta = await fetchJSON(CONFIG.parcelsLayer + "?f=json");
          const set = new Set<string>((meta.fields || []).map((f: any) => f.name));
          setAvailableFields(set);
        } catch {
          setAvailableFields(new Set(desiredFieldsBase));
        }

        // 1) Load all TX ZIPs (polygons)
        const zipRes = await fetchJSON(CONFIG.coaZipLayer + "/query", {
          f: "json",
          where: "STATE='TX'",
          outFields: "ZIPCODE",
          returnGeometry: false,
          resultRecordCount: 5000,
        });
        let feats: string[] = (zipRes.features || [])
          .map((f: any) => cleanZip(f.attributes.ZIPCODE))
          .filter(Boolean) as string[];
        feats = Array.from(new Set(feats)).sort();

        // 2) Parcel counts grouped by situs_zip → aggregate to ZIP5
        const statsRes = await fetchJSON(CONFIG.parcelsLayer + "/query", {
          f: "json",
          where: "1=1",
          outFields: "situs_zip",
          groupByFieldsForStatistics: "situs_zip",
          outStatistics: [
            {
              statisticType: "count",
              onStatisticField: "OBJECTID",
              outStatisticFieldName: "parcel_count",
            },
          ],
          returnGeometry: false,
          resultRecordCount: 50000,
        });
        const statsMap: Record<string, number> = {};
        for (const f of statsRes.features || []) {
          const z = zip5(f.attributes.situs_zip);
          if (!z) continue;
          statsMap[z] = (statsMap[z] || 0) + (Number(f.attributes.parcel_count) || 0);
        }

        const enriched = feats.map((zip) => ({ zip, count: statsMap[zip] ?? 0 }));
        setZips(enriched);
      } catch (e: any) {
        setError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- derived lists for main table ----
  let displayZips = zips;
  if (austinOnly) displayZips = displayZips.filter((z) => z.zip.startsWith("787"));
  const filteredZips = displayZips.filter((z) => z.zip.includes(filter));
  const sortedZips = sortByCount ? [...filteredZips].sort((a, b) => b.count - a.count) : filteredZips;

  function toggle(zip: string) {
    setSelected((s) => (s.includes(zip) ? s.filter((v) => v !== zip) : [...s, zip]));
  }
  function toggleAll() {
    setSelected(selected.length === sortedZips.length ? [] : sortedZips.map((z) => z.zip));
  }

  function exportZips(rows: any[], filename: string) {
    const builder = new CSVBuilder(["zip", "count"]);
    builder.appendRows(rows.map((r) => ({ zip: r.zip, count: r.count })));
    builder.download(filename);
  }

  // ----------------- SERVER-SIDE PAGING (modal) -----------------
  const fieldsForQuery = useMemo(() => {
    // For modal queries, include only fields present on the layer
    return desiredFieldsBase.filter((f) => availableFields.has(f));
  }, [availableFields]);

  const outFields = useMemo(
    () => (fieldsForQuery.length ? fieldsForQuery.join(",") : "*"),
    [fieldsForQuery]
  );

  // Build WHERE clause (zip + optional search)
  const where = useMemo(() => {
    if (!expandedZip) return "1=0";
    const base = `situs_zip LIKE '${expandedZip}%'`; // ZIP5 + ZIP+4 friendly
    const q = parcelFilter.trim();
    if (!q) return base;

    // Simple, broad LIKE search over a few fields (UPPER for case-insensitive)
    const term = q.replace(/'/g, "''").toUpperCase();
    const parts = [
      `UPPER(py_owner_name) LIKE '%${term}%'`,
      `UPPER(situs_address) LIKE '%${term}%'`,
      `CAST(PROP_ID AS VARCHAR(64)) LIKE '%${term}%'`,
      `UPPER(geo_id) LIKE '%${term}%'`,
    ];
    return `${base} AND (${parts.join(" OR ")})`;
  }, [expandedZip, parcelFilter]);

  // Choose a safe server-side order field
  const orderBy = useMemo(() => {
    const k = parcelSort.key;
    const safeKey = availableFields.has(k) ? k : "OBJECTID";
    const dir = parcelSort.dir?.toUpperCase() === "DESC" ? "DESC" : "ASC";
    return `${safeKey} ${dir}`;
  }, [parcelSort, availableFields]);

  // Fetch count (for pagination UI)
  async function fetchCount(modalWhere: string) {
    const res = await fetchJSON(CONFIG.parcelsLayer + "/query", {
      f: "json",
      where: modalWhere,
      returnCountOnly: true,
    });
    return Number(res.count || 0);
  }

  // Fetch one page from server
  async function fetchPageData(modalWhere: string, pageNum: number) {
    const offset = (pageNum - 1) * pageSize;
    const res = await fetchJSON(CONFIG.parcelsLayer + "/query", {
      f: "json",
      where: modalWhere,
      outFields,
      orderByFields: orderBy,
      returnGeometry: false,
      resultOffset: offset,
      resultRecordCount: pageSize,
    });
    const rows = (res.features || []).map((feat: any) => {
      const a = feat.attributes || {};
      return {
        ...a,
        _zip5: zip5(a.situs_zip),
        _owner_type: classifyOwner(a.py_owner_name),
      };
    });
    return rows;
  }

  // Load a new page (modal)
  async function loadPage(pageNum: number, ensureCount = false) {
    try {
      setParcelLoading(true);
      setParcelError(null);
      if (ensureCount) {
        const c = await fetchCount(where);
        setTotalCount(c);
      }
      const rows = await fetchPageData(where, pageNum);
      setPageRows(rows);
      setPage(pageNum);
    } catch (e: any) {
      setParcelError(e.message || String(e));
    } finally {
      setParcelLoading(false);
    }
  }

  // When opening a ZIP, reset and load first page + count
  async function expandZip(zip: string) {
    setExpandedZip(zip);
    setPage(1);
    setPageRows([]);
    setParcelFilter("");
    setParcelError(null);
    setParcelLoading(true);
    setActiveTab("business");
    try {
      const c = await fetchCount(`situs_zip LIKE '${zip}%'`);
      setTotalCount(c);
      const rows = await fetchPageData(`situs_zip LIKE '${zip}%'`, 1);
      setPageRows(rows);
      setPage(1);
    } catch (e) {
      setParcelError((e as any)?.message || String(e));
    } finally {
      setParcelLoading(false);
    }
  }

  // React to sort or filter changes → reload from page 1 (with new count on filter)
  useEffect(() => {
    if (!expandedZip) return;
    loadPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelFilter, expandedZip]);

  useEffect(() => {
    if (!expandedZip) return;
    loadPage(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelSort.key, parcelSort.dir]);

  // Derived UI: filter activeTab on the *current page*
  const pageRowsFilteredByTab = useMemo(
    () => pageRows.filter((p) => classifyOwner(p.py_owner_name) === activeTab),
    [pageRows, activeTab]
  );

  const totalPages = useMemo(() => {
    const c = totalCount ?? 0;
    return Math.max(1, Math.ceil(c / pageSize));
  }, [totalCount]);

  // Export current modal page (respects active tab)
  function exportCurrentPage(filename: string) {
    const rows = pageRowsFilteredByTab;
    const cols = [
      ["py_owner_name", "Owner"],
      ["situs_address", "Situs Address"],
      ["_zip5", "ZIP"],
      ["PROP_ID", "Parcel ID"],
      ["geo_id", "Geo ID"],
      ["land_type_desc", "Land Type"],
      ["tcad_acres", "Acres"],
      ["market_value", "Market Value"],
      ["appraised_val", "Appraised"],
      ["assessed_val", "Assessed"],
    ].filter(([k]) => rows.some((r) => r[k] != null));
    const headers = cols.map(([, label]) => label);
    const mapped = rows.map((r) =>
      Object.fromEntries(
        cols.map(([k, label]) => [
          label,
          ["market_value", "appraised_val", "assessed_val"].includes(k as string)
            ? formatUSD(r[k])
            : r[k],
        ])
      )
    );
    const builder = new CSVBuilder(headers);
    builder.appendRows(mapped as any);
    builder.download(filename);
  }

  // ------------------------------------------------------
  // Export Center: batch exporter
  // ------------------------------------------------------
  const computedColumnKeys = useMemo(() => {
    // Include only columns either computed or present on the layer
    return selectedFields.filter((k) => k.startsWith("_") || availableFields.has(k) || k === "situs_zip");
  }, [selectedFields, availableFields]);

  const columnHeaders = useMemo(
    () => computedColumnKeys.map((k) => ALL_LABELS[k] || k),
    [computedColumnKeys]
  );

  const layerOutFieldsForExport = useMemo(() => {
    // Only request real layer fields; computed fields (_zip5, _owner_type) are added locally
    const real = computedColumnKeys.filter((k) => !k.startsWith("_"));
    return real.length ? real.join(",") : "*";
  }, [computedColumnKeys]);

  const exportZipList = useMemo(() => {
    if (exportScope === "selected") {
      return zips.filter((z) => selected.includes(z.zip));
    }
    if (exportScope === "filtered") {
      return sortedZips;
    }
    // custom
    const raw = customZipInput
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const norm = Array.from(new Set(raw.map((z) => zip5(z)!).filter(Boolean)));
    // attach counts if we have them; else 0
    const map = new Map(zips.map((z) => [z.zip, z.count]));
    return norm.map((zip) => ({ zip, count: map.get(zip) ?? 0 }));
  }, [exportScope, customZipInput, zips, selected, sortedZips]);

  const estimatedTotalRows = useMemo(
    () => exportZipList.reduce((sum, z) => sum + (z.count || 0), 0),
    [exportZipList]
  );

  function setFieldChecked(k: string, on: boolean) {
    setSelectedFields((prev) => (on ? Array.from(new Set([...prev, k])) : prev.filter((x) => x !== k)));
  }

  function ownerPasses(type: OwnerScope, name: string) {
    if (type === "both") return true;
    return classifyOwner(name) === type;
  }

  async function startExport() {
    if (!exportZipList.length) {
      setExportError("No ZIPs to export. Choose a scope or provide custom ZIPs.");
      return;
    }
    setExportError(null);
    setExportRunning(true);
    setExportLog([]);
    setExportTotalRows(0);
    setPerZipProgress({});
    setExportTotalExpected(null);
    startTimeRef.current = Date.now();

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Determine if we stream to a single CSV or trigger per-zip downloads
    let singleBuilder: CSVBuilder | null = null;
    if (exportMode === "single") {
      // Ensure ZIP column is present so downstream can filter
      const keys = computedColumnKeys.includes("_zip5")
        ? computedColumnKeys
        : ["_zip5", ...computedColumnKeys];
      const headers = keys.map((k) => ALL_LABELS[k] || k);
      singleBuilder = new CSVBuilder(headers);
    }

    // Precompute total counts (accurate expected rows); owner filter applied client-side
    try {
      const totals: Record<string, number> = {};
      for (const z of exportZipList) {
        const countRes = await fetchJSONWithRetry(
          CONFIG.parcelsLayer + "/query",
          { f: "json", where: `situs_zip LIKE '${z.zip}%'`, returnCountOnly: true },
          ctrl.signal
        );
        totals[z.zip] = Number(countRes.count || 0);
      }
      const expected = Object.values(totals).reduce((a, b) => a + b, 0);
      setExportTotalExpected(expected);
      appendLog(`Estimated rows across ${exportZipList.length} ZIPs: ${expected.toLocaleString()}`);
    } catch (e: any) {
      appendLog("Could not precompute all counts (continuing anyway).");
    }

    // Export loop (sequential by ZIP for rate-friendliness)
    try {
      for (const z of exportZipList) {
        if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
        appendLog(`Starting ZIP ${z.zip}…`);
        setPerZipProgress((p) => ({ ...p, [z.zip]: { done: 0, total: z.count || 0 } }));

        // If per-zip mode, build headers based on current selection
        let perZipBuilder: CSVBuilder | null = null;
        let perZipKeys = computedColumnKeys;
        if (exportMode === "perZip") {
          perZipBuilder = new CSVBuilder(perZipKeys.map((k) => ALL_LABELS[k] || k));
        }

        // We still request only layer-backed fields; computed added locally
        const outF = layerOutFieldsForExport;
        // Use OBJECTID ASC for stable paging
        const order = availableFields.has("OBJECTID") ? "OBJECTID ASC" : "py_owner_name ASC";

        // Count for this ZIP (for better per-ZIP progress)
        let zipTotal = 0;
        try {
          const cRes = await fetchJSONWithRetry(
            CONFIG.parcelsLayer + "/query",
            { f: "json", where: `situs_zip LIKE '${z.zip}%'`, returnCountOnly: true },
            ctrl.signal
          );
          zipTotal = Number(cRes.count || 0);
        } catch {
          zipTotal = z.count || 0;
        }
        setPerZipProgress((p) => ({ ...p, [z.zip]: { done: 0, total: zipTotal } }));

        // Page through this ZIP
        let offset = 0;
        let processedForZip = 0;

        while (true) {
          if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

          const res = await fetchJSONWithRetry(
            CONFIG.parcelsLayer + "/query",
            {
              f: "json",
              where: `situs_zip LIKE '${z.zip}%'`,
              outFields: outF,
              orderByFields: order,
              returnGeometry: false,
              resultOffset: offset,
              resultRecordCount: pageSize,
            },
            ctrl.signal
          );

          const feats = res.features || [];
          if (!feats.length) break;

          // Map + compute + optional owner filter
          let mapped = feats.map((feat: any) => {
            const a = feat.attributes || {};
            const row: Record<string, any> = { ...a };
            row._zip5 = zip5(a.situs_zip);
            row._owner_type = classifyOwner(a.py_owner_name);
            return row;
          });

          if (ownerScope !== "both") {
            mapped = mapped.filter((r) => ownerPasses(ownerScope, r.py_owner_name));
          }

          // Prepare CSV row objects in the exact selected order
          const toCSVRows = mapped.map((r) => {
            const obj: Record<string, any> = {};
            // Choose the target column set (single file may include _zip5 prepended)
            const keys =
              exportMode === "single"
                ? (singleBuilder!.headers.map((h) => Object.keys(ALL_LABELS).find((k) => ALL_LABELS[k] === h) || h))
                : perZipBuilder!.headers.map((h) => Object.keys(ALL_LABELS).find((k) => ALL_LABELS[k] === h) || h);

            for (const k of keys) {
              let val = r[k];
              if (k === "market_value" || k === "appraised_val" || k === "assessed_val") {
                val = formatUSD(val);
              }
              obj[ALL_LABELS[k] || k] = val;
            }
            return obj;
          });

          // Append to CSV(s)
          if (exportMode === "single") singleBuilder!.appendRows(toCSVRows);
          else perZipBuilder!.appendRows(toCSVRows);

          // Optional webhook streaming (NDJSON)
          if (webhookUrl) {
            const batches = chunkArray(mapped, webhookBatchSize);
            for (const b of batches) {
              await postNDJSON(webhookUrl, b, ctrl.signal);
            }
          }

          // Progress
          offset += feats.length;
          processedForZip += feats.length;
          setPerZipProgress((p) => ({
            ...p,
            [z.zip]: { done: Math.min(processedForZip, zipTotal || processedForZip), total: zipTotal },
          }));
          setExportTotalRows((n) => n + feats.length);

          // Polite throttle between page pulls
          if (throttleMs > 0) await sleep(throttleMs, ctrl.signal);
        }

        // Finish this ZIP (download per-zip if applicable)
        if (exportMode === "perZip") {
          perZipBuilder!.download(`${filePrefix}_${z.zip}.csv`);
        }
        appendLog(`Finished ZIP ${z.zip} (${processedForZip.toLocaleString()} rows).`);
      }

      if (exportMode === "single") {
        const suffix =
          ownerScope === "both"
            ? "all"
            : ownerScope === "business"
            ? "business"
            : "residential";
        singleBuilder!.download(`${filePrefix}_${suffix}_multi_zips.csv`);
      }

      appendLog("Export complete.");
    } catch (e: any) {
      if (e?.name === "AbortError") {
        appendLog("Export cancelled.");
      } else {
        const msg = e?.message || String(e);
        setExportError(msg);
        appendLog(`Error: ${msg}`);
      }
    } finally {
      setExportRunning(false);
      abortRef.current = null;
    }
  }

  function cancelExport() {
    abortRef.current?.abort();
  }

  // Helpers
  function chunkArray<T>(arr: T[], size: number) {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function postNDJSON(url: string, objects: any[], signal?: AbortSignal) {
    const nd = objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: nd,
      signal,
    });
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
  }

  const elapsedSecs = exportRunning ? Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000)) : 0;
  const rate = exportRunning ? Math.round(exportTotalRows / elapsedSecs) : 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white dark:from-slate-900 dark:to-slate-950 text-slate-800 dark:text-slate-100 p-6 font-sans">
      <h1 className="text-3xl font-extrabold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-emerald-600 to-indigo-600">
        Austin/Travis ZIPs with Parcel Counts
      </h1>

      {loading && <p>Loading…</p>}
      {error && <p className="text-red-600">Error: {error}</p>}

      {!loading && !error && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex flex-wrap gap-3 items-center rounded-2xl border bg-white/80 dark:bg-slate-900/50 backdrop-blur p-4 shadow-sm dark:border-slate-700">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by ZIP"
              className="border rounded-xl px-3 py-2 bg-white/70 dark:bg-slate-800/60
                         text-slate-900 dark:text-slate-100 placeholder-slate-400
                         focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition"
            />
            <button
              onClick={toggleAll}
              className="px-3 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 transition"
            >
              {selected.length === sortedZips.length ? "Clear All" : "Select All"}
            </button>
            <button
              onClick={() => setSortByCount((s) => !s)}
              className="px-3 py-2 rounded-xl border border-slate-300 hover:bg-emerald-50/60 dark:hover:bg-emerald-900/20 dark:border-slate-700 transition text-slate-900 dark:text-slate-100"
            >
              {sortByCount ? "Sort by ZIP" : "Sort by Parcel Count"}
            </button>
            <label className="flex items-center gap-2 text-sm rounded-full px-3 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-800 dark:text-emerald-200">
              <input type="checkbox" checked={austinOnly} onChange={(e) => setAustinOnly(e.target.checked)} />
              Austin-only (787xx)
            </label>

            <button
              onClick={() => exportZips(sortedZips as any, "all_zips.csv")}
              className="px-3 py-2 rounded-xl bg-violet-600 text-white hover:bg-violet-500 shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-400 transition"
              disabled={!sortedZips.length}
            >
              Export All (Visible List)
            </button>

            <button
              onClick={() => setExportOpen(true)}
              className="ml-auto px-3 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 transition"
            >
              Open Export Center
            </button>

            <span className="text-sm text-emerald-700 font-semibold dark:text-emerald-300">
              {selected.length} selected
            </span>
          </div>

          {/* ZIP table */}
          <div className="max-h-[500px] overflow-auto border rounded-2xl shadow-sm bg-white/80 dark:bg-slate-900/50 dark:border-slate-700 custom-scroll">
            <table className="min-w-full text-sm text-slate-900 dark:text-slate-100">
              <thead className="bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 sticky top-0 shadow-sm">
                <tr>
                  <th className="px-2 py-2 text-left"></th>
                  <th className="px-2 py-2 text-left">ZIP</th>
                  <th className="px-2 py-2 text-right">Parcels</th>
                  <th className="px-2 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedZips.map((z) => (
                  <tr
                    key={z.zip}
                    className={`odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-700 ${
                      selected.includes(z.zip) ? "ring-1 ring-emerald-300 dark:ring-emerald-800" : ""
                    }`}
                  >
                    <td className="px-2 py-1">
                      <input type="checkbox" checked={selected.includes(z.zip)} onChange={() => toggle(z.zip)} />
                    </td>
                    <td className="px-2 py-1 font-mono">{z.zip}</td>
                    <td className="px-2 py-1 text-right font-semibold">{z.count.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right">
                      <button
                        className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-500"
                        onClick={() => expandZip(z.zip)}
                      >
                        Expand
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------------------- Parcel Modal ---------------------- */}
      {expandedZip && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 fade-in">
          <div className="rounded-2xl shadow-2xl w-11/12 max-h-[92vh] flex flex-col bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 slide-up">
            <div className="p-4 border-b bg-gradient-to-r from-indigo-600/10 to-emerald-600/10 flex flex-wrap gap-2 items-center justify-between dark:from-indigo-500/10 dark:to-emerald-500/10">
              <h2 className="font-bold text-lg">Parcels in ZIP {expandedZip}</h2>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => setActiveTab("business")}
                  className={`px-3 py-1 rounded ${activeTab === "business" ? "bg-indigo-600 text-white" : "bg-slate-200 dark:bg-slate-700"}`}
                >
                  Business
                </button>
                <button
                  onClick={() => setActiveTab("residential")}
                  className={`px-3 py-1 rounded ${activeTab === "residential" ? "bg-indigo-600 text-white" : "bg-slate-200 dark:bg-slate-700"}`}
                >
                  Residential
                </button>
                <input
                  value={parcelFilter}
                  onChange={(e) => setParcelFilter(e.target.value)}
                  placeholder="Search owner / address / id"
                  className="border border-slate-400 dark:border-slate-600 rounded px-2 py-1 text-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
                />
                <select
                  value={parcelSort.key}
                  onChange={(e) => setParcelSort({ key: e.target.value, dir: parcelSort.dir })}
                  className="border border-slate-400 dark:border-slate-600 rounded px-2 py-1 text-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
                >
                  <option value="py_owner_name">Owner</option>
                  <option value="situs_address">Situs</option>
                  <option value="PROP_ID">Parcel ID</option>
                  <option value="market_value">Market Value</option>
                  <option value="tcad_acres">Acres</option>
                </select>
                <button
                  className="border rounded px-2 py-1 text-sm"
                  onClick={() => setParcelSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
                >
                  {parcelSort.dir === "asc" ? "Asc" : "Desc"}
                </button>
                <button
                  className="border rounded px-2 py-1 text-sm bg-blue-600 text-white"
                  onClick={() => exportCurrentPage(`${expandedZip}_${activeTab}_page${page}.csv`)}
                >
                  Export Current Page
                </button>
                <button onClick={() => setExpandedZip(null)} className="ml-2 text-red-600 hover:underline">
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-white dark:bg-slate-900 custom-scroll">
              {parcelLoading && <p className="p-4">Loading parcels…</p>}
              {parcelError && <p className="p-4 text-red-600">{parcelError}</p>}
              {!parcelLoading && !parcelError && (
                <>
                  <table className="min-w-full text-sm text-slate-900 dark:text-slate-100">
                    <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-semibold shadow-sm">
                      <tr>
                        <th className="px-2 py-1 text-left">Owner</th>
                        <th className="px-2 py-1 text-left">Situs Address</th>
                        <th className="px-2 py-1 text-left">ZIP</th>
                        <th className="px-2 py-1 text-left">Parcel ID</th>
                        <th className="px-2 py-1 text-left">Geo ID</th>
                        <th className="px-2 py-1 text-left">Land Type</th>
                        <th className="px-2 py-1 text-right">Acres</th>
                        <th className="px-2 py-1 text-right">Market</th>
                        <th className="px-2 py-1 text-right">Appraised</th>
                        <th className="px-2 py-1 text-right">Assessed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRowsFilteredByTab.map((p, idx) => (
                        <tr
                          key={idx}
                          className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-700"
                        >
                          <td className="px-2 py-1">{p.py_owner_name}</td>
                          <td className="px-2 py-1">{p.situs_address}</td>
                          <td className="px-2 py-1">{p._zip5}</td>
                          <td className="px-2 py-1">{p.PROP_ID}</td>
                          <td className="px-2 py-1">{p.geo_id}</td>
                          <td className="px-2 py-1">{p.land_type_desc}</td>
                          <td className="px-2 py-1 text-right">{p.tcad_acres}</td>
                          <td className="px-2 py-1 text-right">{formatUSD(p.market_value)}</td>
                          <td className="px-2 py-1 text-right">{formatUSD(p.appraised_val)}</td>
                          <td className="px-2 py-1 text-right">{formatUSD(p.assessed_val)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="p-2 flex items-center gap-3 border-t border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-900/70 sticky bottom-0">
                    <span className="text-sm text-slate-700 dark:text-slate-200">
                      {totalCount != null ? `${totalCount.toLocaleString()} rows • ` : ""}
                      Page {page} / {totalPages}
                    </span>
                    <button
                      className="px-2 py-1 border rounded disabled:opacity-50"
                      disabled={page <= 1 || parcelLoading}
                      onClick={() => loadPage(Math.max(1, page - 1))}
                    >
                      Prev
                    </button>
                    <button
                      className="px-2 py-1 border rounded disabled:opacity-50"
                      disabled={page >= totalPages || parcelLoading}
                      onClick={() => loadPage(Math.min(totalPages, page + 1))}
                    >
                      Next
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------------------- Export Center (Slide-over) ---------------------- */}
      {exportOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40" onClick={() => !exportRunning && setExportOpen(false)} />
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 h-full overflow-auto shadow-2xl slide-in-right">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Export Center</h2>
              <button
                className="text-red-600 hover:underline disabled:opacity-50"
                disabled={exportRunning}
                onClick={() => setExportOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="p-4 space-y-5">
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Scope</h3>
                <div className="flex gap-2 flex-wrap">
                  <button
                    className={`tag ${exportScope === "selected" ? "tag-active" : ""}`}
                    onClick={() => setExportScope("selected")}
                  >
                    Selected ({selected.length})
                  </button>
                  <button
                    className={`tag ${exportScope === "filtered" ? "tag-active" : ""}`}
                    onClick={() => setExportScope("filtered")}
                  >
                    Filtered ({sortedZips.length})
                  </button>
                  <button
                    className={`tag ${exportScope === "custom" ? "tag-active" : ""}`}
                    onClick={() => setExportScope("custom")}
                  >
                    Custom list
                  </button>
                </div>
                {exportScope === "custom" && (
                  <textarea
                    className="w-full h-24 border rounded-xl p-2 bg-white/70 dark:bg-slate-800/60"
                    placeholder="Enter ZIPs separated by commas, spaces, or new lines (e.g., 78701,78702, 78704)"
                    value={customZipInput}
                    onChange={(e) => setCustomZipInput(e.target.value)}
                  />
                )}
                <div className="text-xs text-slate-600 dark:text-slate-400">
                  Estimated rows (no owner filter): {estimatedTotalRows.toLocaleString()}
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Owner Type</h3>
                <div className="flex gap-2">
                  <button className={`tag ${ownerScope === "both" ? "tag-active" : ""}`} onClick={() => setOwnerScope("both")}>
                    Both
                  </button>
                  <button
                    className={`tag ${ownerScope === "business" ? "tag-active" : ""}`}
                    onClick={() => setOwnerScope("business")}
                  >
                    Business
                  </button>
                  <button
                    className={`tag ${ownerScope === "residential" ? "tag-active" : ""}`}
                    onClick={() => setOwnerScope("residential")}
                  >
                    Residential
                  </button>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Note: Business/residential is classified client-side from owner name patterns.
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Columns</h3>
                <div className="grid grid-cols-2 gap-2">
                  {Object.keys(ALL_LABELS).map((k) => {
                    const present = k.startsWith("_") || availableFields.has(k) || k === "situs_zip";
                    return (
                      <label key={k} className={`flex items-center gap-2 rounded-lg px-2 py-1 border ${present ? "border-slate-300 dark:border-slate-700" : "border-rose-300 bg-rose-50/50 dark:border-rose-800/60 dark:bg-rose-900/20"}`}>
                        <input
                          type="checkbox"
                          disabled={!present}
                          checked={selectedFields.includes(k)}
                          onChange={(e) => setFieldChecked(k, e.target.checked)}
                        />
                        <span className={`text-sm ${present ? "" : "line-through opacity-60"}`}>{ALL_LABELS[k]}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Unavailable columns are shown struck-through (not present on the layer).
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Output</h3>
                <div className="flex gap-2">
                  <button className={`tag ${exportMode === "single" ? "tag-active" : ""}`} onClick={() => setExportMode("single")}>
                    Single CSV (all ZIPs)
                  </button>
                  <button className={`tag ${exportMode === "perZip" ? "tag-active" : ""}`} onClick={() => setExportMode("perZip")}>
                    One CSV per ZIP
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm w-28">File prefix</label>
                  <input
                    value={filePrefix}
                    onChange={(e) => setFilePrefix(e.target.value)}
                    className="flex-1 border rounded-xl px-3 py-1 bg-white/70 dark:bg-slate-800/60"
                  />
                </div>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Advanced</h3>
                <div className="flex items-center gap-2">
                  <label className="text-sm w-28">Throttle (ms)</label>
                  <input
                    type="number"
                    min={0}
                    value={throttleMs}
                    onChange={(e) => setThrottleMs(Math.max(0, Number(e.target.value || 0)))}
                    className="w-28 border rounded-xl px-3 py-1 bg-white/70 dark:bg-slate-800/60"
                  />
                  <span className="text-xs text-slate-500">Pause between page pulls (politeness).</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm w-28">Webhook URL</label>
                  <input
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="Optional: POST NDJSON rows per batch"
                    className="flex-1 border rounded-xl px-3 py-1 bg-white/70 dark:bg-slate-800/60"
                  />
                </div>
                {webhookUrl && (
                  <div className="flex items-center gap-2">
                    <label className="text-sm w-28">Batch size</label>
                    <input
                      type="number"
                      min={50}
                      value={webhookBatchSize}
                      onChange={(e) => setWebhookBatchSize(Math.max(50, Number(e.target.value || 0)))}
                      className="w-28 border rounded-xl px-3 py-1 bg-white/70 dark:bg-slate-800/60"
                    />
                    <span className="text-xs text-slate-500">Rows per POST as NDJSON.</span>
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <div className="flex items-center gap-3">
                  <button
                    className="px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-60"
                    disabled={exportRunning}
                    onClick={startExport}
                  >
                    Start Export
                  </button>
                  <button
                    className="px-4 py-2 rounded-xl bg-rose-600 text-white hover:bg-rose-500 disabled:opacity-60"
                    disabled={!exportRunning}
                    onClick={cancelExport}
                  >
                    Cancel
                  </button>
                  <div className="text-sm text-slate-600 dark:text-slate-300">
                    {exportRunning ? (
                      <>
                        <span className="font-medium">Running</span> • {exportTotalRows.toLocaleString()} rows • ~{rate}/s
                      </>
                    ) : (
                      <span className="font-medium">Idle</span>
                    )}
                  </div>
                </div>

                {/* Global progress */}
                <div className="progress-wrap">
                  <div className="progress-label">
                    Total {exportTotalRows.toLocaleString()}
                    {exportTotalExpected != null ? ` / ${exportTotalExpected.toLocaleString()}` : ""}
                  </div>
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{
                        width:
                          exportTotalExpected && exportTotalExpected > 0
                            ? Math.min(100, Math.round((exportTotalRows / exportTotalExpected) * 100)) + "%"
                            : "0%",
                      }}
                    />
                  </div>
                </div>

                {/* Per-ZIP progress list */}
                <div className="max-h-56 overflow-auto custom-scroll border rounded-xl p-2 bg-white/60 dark:bg-slate-800/50">
                  {exportZipList.map((z) => {
                    const p = perZipProgress[z.zip] || { done: 0, total: z.count || 0 };
                    const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
                    return (
                      <div key={z.zip} className="mb-2">
                        <div className="flex justify-between text-xs">
                          <span className="font-mono">{z.zip}</span>
                          <span className="text-slate-500">{p.done.toLocaleString()} / {p.total.toLocaleString()} ({pct}%)</span>
                        </div>
                        <div className="progress-bar h-2">
                          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Log & error */}
                {exportError && <div className="text-sm text-rose-600">{exportError}</div>}
                <details className="log-panel">
                  <summary className="cursor-pointer text-sm">Activity Log</summary>
                  <pre className="log-pre">{exportLog.join("\n") || "No messages yet."}</pre>
                </details>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
