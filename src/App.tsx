import React, { useEffect, useMemo, useState } from "react";

/**
 * Travis County ZIP + Owner Scraper Wizard (with Austin Geocoder)
 * --------------------------------------------------------------
 * Feature 3 implemented: True server-side paging for parcel expansion.
 * - Uses resultOffset/resultRecordCount + orderByFields
 * - Gets total row count with returnCountOnly
 * - Exports current page (since we don't load all rows anymore)
 * - Keeps dark-mode contrast fixes from last pass
 */

const CONFIG = {
  coaZipLayer:
    "https://maps.austintexas.gov/arcgis/rest/services/Shared/BoundariesGrids_1/MapServer/5",
  parcelsLayer:
    "https://taxmaps.traviscountytx.gov/arcgis/rest/services/Parcels/MapServer/0",
};

// ------------------------- fetch helpers -------------------------
async function fetchJSON(url: string, body?: Record<string, any>) {
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
      }
    : { method: "GET" };
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

function exportCSV(
  rows: Record<string, any>[],
  headers: string[],
  filename = "export.csv"
) {
  if (!rows.length) return;
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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

// ------------------------- main -------------------------
export default function App() {
  const [zips, setZips] = useState<{ zip: string; count: number }[]>([]);
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

  const [activeTab, setActiveTab] = useState<"business" | "residential">(
    "business"
  );
  const [parcelFilter, setParcelFilter] = useState("");
  const [parcelSort, setParcelSort] = useState<{
    key: string;
    dir: "asc" | "desc";
  }>({ key: "py_owner_name", dir: "asc" });

  // Server-side paging state
  const [page, setPage] = useState(1);
  const pageSize = 500;
  const [pageRows, setPageRows] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  // Dynamic field discovery for parcels layer
  const [availableFields, setAvailableFields] = useState<Set<string>>(
    new Set()
  );
  const desiredFields = [
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
          setAvailableFields(
            new Set([
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
            ])
          );
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
          statsMap[z] =
            (statsMap[z] || 0) + (Number(f.attributes.parcel_count) || 0);
        }

        const enriched = feats.map((zip) => ({ zip, count: statsMap[zip] ?? 0 }));
        setZips(enriched);
      } catch (e: any) {
        setError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ---- derived lists for main table ----
  let displayZips = zips;
  if (austinOnly) displayZips = displayZips.filter((z) => z.zip.startsWith("787"));
  const filteredZips = displayZips.filter((z) => z.zip.includes(filter));
  const sortedZips = sortByCount
    ? [...filteredZips].sort((a, b) => b.count - a.count)
    : filteredZips;

  function toggle(zip: string) {
    setSelected((s) =>
      s.includes(zip) ? s.filter((v) => v !== zip) : [...s, zip]
    );
  }
  function toggleAll() {
    setSelected(
      selected.length === sortedZips.length ? [] : sortedZips.map((z) => z.zip)
    );
  }

  function exportZips(rows: any[], filename: string) {
    exportCSV(rows as any, ["zip", "count"], filename);
  }

  // ----------------- SERVER-SIDE PAGING: helpers -----------------
  const fieldsForQuery = useMemo(
    () => desiredFields.filter((f) => availableFields.has(f)),
    [availableFields]
  );
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
  async function fetchCount() {
    const res = await fetchJSON(CONFIG.parcelsLayer + "/query", {
      f: "json",
      where,
      returnCountOnly: true,
    });
    const c = Number(res.count || 0);
    setTotalCount(c);
    return c;
  }

  // Fetch one page from server
  async function fetchPageData(pageNum: number) {
    const offset = (pageNum - 1) * pageSize;
    const res = await fetchJSON(CONFIG.parcelsLayer + "/query", {
      f: "json",
      where,
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

  // Load a new page (sets loading + error)
  async function loadPage(pageNum: number, ensureCount = false) {
    try {
      setParcelLoading(true);
      setParcelError(null);
      if (ensureCount) await fetchCount();
      const rows = await fetchPageData(pageNum);
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
      await loadPage(1, true);
    } finally {
      setParcelLoading(false);
    }
  }

  // React to sort or filter changes → reload from page 1 (with new count on filter)
  useEffect(() => {
    if (!expandedZip) return;
    // If filter changes, count likely changes too
    loadPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelFilter, expandedZip]);

  useEffect(() => {
    if (!expandedZip) return;
    // Sort doesn’t change count; just reload current page 1 to keep things simple
    loadPage(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelSort.key, parcelSort.dir]);

  // Derived UI: filter activeTab on the *current page*
  const pageRowsFilteredByTab = useMemo(
    () =>
      pageRows.filter(
        (p) => classifyOwner(p.py_owner_name) === activeTab
      ),
    [pageRows, activeTab]
  );

  const totalPages = useMemo(() => {
    const c = totalCount ?? 0;
    return Math.max(1, Math.ceil(c / pageSize));
  }, [totalCount]);

  // Export current page (respects active tab filter)
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
          ["market_value", "appraised_val", "assessed_val"].includes(
            k as string
          )
            ? formatUSD(r[k])
            : r[k],
        ])
      )
    );
    exportCSV(mapped as any, headers, filename);
  }

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
              <input
                type="checkbox"
                checked={austinOnly}
                onChange={(e) => setAustinOnly(e.target.checked)}
              />
              Austin-only (787xx)
            </label>
            <button
              onClick={() => exportZips(sortedZips as any, "all_zips.csv")}
              className="px-3 py-2 rounded-xl bg-violet-600 text-white hover:bg-violet-500 shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-400 transition"
              disabled={!sortedZips.length}
            >
              Export All (Visible List)
            </button>
            <span className="ml-auto text-sm text-emerald-700 font-semibold dark:text-emerald-300">
              {selected.length} selected
            </span>
          </div>

          {/* ZIP table */}
          <div className="max-h-[500px] overflow-auto border rounded-2xl shadow-sm bg-white/80 dark:bg-slate-900/50 dark:border-slate-700">
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
                      selected.includes(z.zip)
                        ? "ring-1 ring-emerald-300 dark:ring-emerald-800"
                        : ""
                    }`}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={selected.includes(z.zip)}
                        onChange={() => toggle(z.zip)}
                      />
                    </td>
                    <td className="px-2 py-1 font-mono">{z.zip}</td>
                    <td className="px-2 py-1 text-right font-semibold">
                      {z.count.toLocaleString()}
                    </td>
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

      {/* ---------------------- Modal ---------------------- */}
      {expandedZip && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="rounded-2xl shadow-2xl w-11/12 max-h-[92vh] flex flex-col bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100">
            <div className="p-4 border-b bg-gradient-to-r from-indigo-600/10 to-emerald-600/10 flex flex-wrap gap-2 items-center justify-between dark:from-indigo-500/10 dark:to-emerald-500/10">
              <h2 className="font-bold text-lg">Parcels in ZIP {expandedZip}</h2>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => setActiveTab("business")}
                  className={`px-3 py-1 rounded ${
                    activeTab === "business"
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-200 dark:bg-slate-700"
                  }`}
                >
                  Business
                </button>
                <button
                  onClick={() => setActiveTab("residential")}
                  className={`px-3 py-1 rounded ${
                    activeTab === "residential"
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-200 dark:bg-slate-700"
                  }`}
                >
                  Residential
                </button>
                <input
                  value={parcelFilter}
                  onChange={(e) => {
                    setParcelFilter(e.target.value);
                    // page resets via effect
                  }}
                  placeholder="Search owner / address / id"
                  className="border border-slate-400 dark:border-slate-600 rounded px-2 py-1 text-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
                />
                <select
                  value={parcelSort.key}
                  onChange={(e) =>
                    setParcelSort({ key: e.target.value, dir: parcelSort.dir })
                  }
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
                  onClick={() =>
                    setParcelSort((s) => ({
                      ...s,
                      dir: s.dir === "asc" ? "desc" : "asc",
                    }))
                  }
                >
                  {parcelSort.dir === "asc" ? "Asc" : "Desc"}
                </button>
                <button
                  className="border rounded px-2 py-1 text-sm bg-blue-600 text-white"
                  onClick={() =>
                    exportCurrentPage(`${expandedZip}_${activeTab}_page${page}.csv`)
                  }
                >
                  Export Current Page
                </button>
                <button
                  onClick={() => setExpandedZip(null)}
                  className="ml-2 text-red-600 hover:underline"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-white dark:bg-slate-900">
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
                          <td className="px-2 py-1 text-right">
                            {formatUSD(p.market_value)}
                          </td>
                          <td className="px-2 py-1 text-right">
                            {formatUSD(p.appraised_val)}
                          </td>
                          <td className="px-2 py-1 text-right">
                            {formatUSD(p.assessed_val)}
                          </td>
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
    </div>
  );
}
