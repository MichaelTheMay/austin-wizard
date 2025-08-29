import React, { useEffect, useMemo, useState, useRef } from "react";
import "./app.css";
import { CONFIG, fetchJSON, fetchJSONWithRetry } from "./lib/api";
import { zip5, cleanZip, formatUSD, exportCSV, classifyOwner, ownerScopeWhere, exportTile, isLikelyPersonName, splitPersonNames, normalizeOwnerName, normalizeAddress, parseNumber, normalizeOwnerKey } from "./lib/utils";
import BarList from "./components/BarList";
import ErrorBoundary from "./components/ErrorBoundary";
const Analytics = React.lazy(() => import("./pages/Analytics"));

/**
 * Travis County ZIP + Owner Scraper Wizard (with Austin Geocoder)
 * ----------------------------------------------------------------
 * Data Lab:
 * - Scope selector: Selected / Filtered / 787xx / All Travis / Custom ZIPs.
 * - Owner filter (approx server-side): Both / Business / Residential.
 * - KPIs: total parcels, business share, sum market value, avg value.
 * - Histograms: mfarket_value, acres (bin counts via batched count queries).
 * - Compositions: land_type_desc share (groupBy).
 * - Leaderboards: Top owners (by count/value), Top ZIPs.
 * - Drill-in: click owner/ZIP to open parcel modal with prefilled filter.
 * - Export tile data to CSV; Save & load “Data Lab Views” (localStorage).
 *
 * Notes:
 * - “Business/Residential” owner filter is approximated on the server by
 *   tokenized LIKE patterns in py_owner_name for scale (client classification
 *   is still used elsewhere).
 */



type OwnerTab = "business" | "residential";
type OwnerScope = "both" | OwnerTab;
type ZipRow = { zip: string; count: number };

// ------------------------- main -------------------------
export default function App() {
  // Simple hash-based routing
  const [route, setRoute] = useState<string>(() => location.hash.replace(/^#/, "") || "/");
  useEffect(() => {
    const onHash = () => setRoute(location.hash.replace(/^#/, "") || "/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
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
  const [parcelSort, setParcelSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "py_owner_name", dir: "asc" });

  // Server-side paging state
  const [page, setPage] = useState(1);
  const pageSize = 500;
  const [pageRows, setPageRows] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  // Dynamic fields for parcels layer
  const [availableFields, setAvailableFields] = useState<Set<string>>(new Set());
  const desiredFields = [
    "py_owner_name","situs_address","situs_zip","PROP_ID","geo_id","land_type_desc","tcad_acres","market_value","appraised_val","assessed_val",
  ];

  // --------------- bootstrap ---------------
  useEffect(() => {
    (async () => {
      try {
        setLoading(true); setError(null);
        try {
          const meta = await fetchJSON(CONFIG.parcelsLayer + "?f=json");
          const set = new Set<string>((meta.fields || []).map((f: any) => f.name));
          setAvailableFields(set);
        } catch {
          setAvailableFields(new Set(desiredFields));
        }
        // ZIP polygons
        const zipRes = await fetchJSON(CONFIG.coaZipLayer + "/query", {
          f: "json", where: "STATE='TX'", outFields: "ZIPCODE", returnGeometry: false, resultRecordCount: 5000,
        });
        let feats: string[] = (zipRes.features || []).map((f: any) => cleanZip(f.attributes.ZIPCODE)).filter(Boolean) as string[];
        feats = Array.from(new Set(feats)).sort();
        // Parcel counts by situs_zip (aggregate to ZIP5)
        const statsRes = await fetchJSON(CONFIG.parcelsLayer + "/query", {
          f: "json",
          where: "1=1",
          outFields: "situs_zip",
          groupByFieldsForStatistics: "situs_zip",
          outStatistics: [{ statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "parcel_count" }],
          returnGeometry: false, resultRecordCount: 50000,
        });
        const statsMap: Record<string, number> = {};
        for (const f of statsRes.features || []) {
          const z = zip5(f.attributes.situs_zip);
          if (!z) continue;
          statsMap[z] = (statsMap[z] || 0) + (Number(f.attributes.parcel_count) || 0);
        }
        const enriched = feats.map((zip) => ({ zip, count: statsMap[zip] ?? 0 }));
        setZips(enriched);
      } catch (e: any) { setError(e.message || String(e));
      } finally { setLoading(false); }
    })();
  }, []);

  // ---- derived lists for main table ----
  let displayZips = zips;
  if (austinOnly) displayZips = displayZips.filter((z) => z.zip.startsWith("787"));
  const filteredZips = displayZips.filter((z) => z.zip.includes(filter));
  const sortedZips = sortByCount ? [...filteredZips].sort((a, b) => b.count - a.count) : filteredZips;

  function toggle(zip: string) { setSelected((s) => (s.includes(zip) ? s.filter((v) => v !== zip) : [...s, zip])); }
  function toggleAll() { setSelected(selected.length === sortedZips.length ? [] : sortedZips.map((z) => z.zip)); }

  function exportZips(rows: any[], filename: string) {
    exportCSV(rows as any, ["zip", "count"], filename);
  }

  // ----------------- SERVER-SIDE PAGING (modal) -----------------
  const fieldsForQuery = useMemo(() => desiredFields.filter((f) => availableFields.has(f)), [availableFields]);
  const outFields = useMemo(() => (fieldsForQuery.length ? fieldsForQuery.join(",") : "*"), [fieldsForQuery]);

  const where = useMemo(() => {
    if (!expandedZip) return "1=0";
    const base = `situs_zip LIKE '${expandedZip}%'`;
    const q = parcelFilter.trim();
    if (!q) return base;
    const term = q.replace(/'/g, "''").toUpperCase();
    const parts = [
      `UPPER(py_owner_name) LIKE '%${term}%'`,
      `UPPER(situs_address) LIKE '%${term}%'`,
      `CAST(PROP_ID AS VARCHAR(64)) LIKE '%${term}%'`,
      `UPPER(geo_id) LIKE '%${term}%'`,
    ];
    return `${base} AND (${parts.join(" OR ")})`;
  }, [expandedZip, parcelFilter]);

  const orderBy = useMemo(() => {
    const k = parcelSort.key;
    const safeKey = availableFields.has(k) ? k : "OBJECTID";
    const dir = parcelSort.dir?.toUpperCase() === "DESC" ? "DESC" : "ASC";
    return `${safeKey} ${dir}`;
  }, [parcelSort, availableFields]);

  async function fetchCount(modalWhere: string) {
    const res = await fetchJSON(CONFIG.parcelsLayer + "/query", { f: "json", where: modalWhere, returnCountOnly: true });
    return Number(res.count || 0);
  }

  async function fetchPageData(modalWhere: string, pageNum: number) {
    const offset = (pageNum - 1) * pageSize;
    const res = await fetchJSON(CONFIG.parcelsLayer + "/query", {
      f: "json", where: modalWhere, outFields, orderByFields: orderBy, returnGeometry: false,
      resultOffset: offset, resultRecordCount: pageSize,
    });
    const rows = (res.features || []).map((feat: any) => {
      const a = feat.attributes || {};
      // cleaned fields
      const owner_clean = normalizeOwnerName(a.py_owner_name || "");
      const situs_clean = normalizeAddress(a.situs_address || "");
      const market_value_num = parseNumber(a.market_value);
      const owner_persons = splitPersonNames(a.py_owner_name);
      const first_person = owner_persons[0] || null;
      const owner_keys = owner_persons.map((p: any) => normalizeOwnerKey(p.full)).filter(Boolean);
      return {
        ...a,
        _zip5: zip5(a.situs_zip),
        _owner_type: classifyOwner(a.py_owner_name),
        _owner_clean: owner_clean,
        _situs_clean: situs_clean,
        _market_value_num: market_value_num,
        _owner_persons: owner_persons,
        _owner_keys: owner_keys,
        _owner_first: first_person ? first_person.first : null,
        _owner_last: first_person ? first_person.last : null,
      };
    });
    return rows;
  }

  async function loadPage(pageNum: number, ensureCount = false) {
    try {
      setParcelLoading(true); setParcelError(null);
      if (ensureCount) { const c = await fetchCount(where); setTotalCount(c); }
      const rows = await fetchPageData(where, pageNum);
      setPageRows(rows); setPage(pageNum);
    } catch (e: any) { setParcelError(e.message || String(e));
    } finally { setParcelLoading(false); }
  }

  async function expandZip(zip: string) {
    setExpandedZip(zip);
    setPage(1); setPageRows([]); setParcelFilter(""); setParcelError(null); setParcelLoading(true); setActiveTab("business");
    try {
      const c = await fetchCount(`situs_zip LIKE '${zip}%'`); setTotalCount(c);
      const rows = await fetchPageData(`situs_zip LIKE '${zip}%'`, 1);
      setPageRows(rows); setPage(1);
    } catch (e) { setParcelError((e as any)?.message || String(e));
    } finally { setParcelLoading(false); }
  }

  useEffect(() => { if (expandedZip) loadPage(1, true); }, [parcelFilter, expandedZip]);
  useEffect(() => { if (expandedZip) loadPage(1, false); }, [parcelSort.key, parcelSort.dir]);

  const pageRowsFilteredByTab = useMemo(
    () => pageRows.filter((p) => {
      const c = classifyOwner(p.py_owner_name);
      if (activeTab === "residential") {
        // require both classifyOwner=resident and owner appears to be a person's name
        return c === "residential" && isLikelyPersonName(p.py_owner_name);
      }
      return c === activeTab;
    }),
    [pageRows, activeTab]
  );
  const totalPages = useMemo(() => Math.max(1, Math.ceil((totalCount ?? 0) / pageSize)), [totalCount]);

  function exportCurrentPage(filename: string) {
    const rows = pageRowsFilteredByTab;
    const cols = [
  ["py_owner_name", "Owner"], ["_owner_first", "First Name"], ["_owner_last", "Last Name"], ["_owner_clean", "Owner (clean)"], ["_situs_clean", "Situs Address"], ["_zip5", "ZIP"],
      ["PROP_ID", "Parcel ID"], ["geo_id", "Geo ID"], ["land_type_desc", "Land Type"],
      ["tcad_acres", "Acres"], ["market_value", "Market Value"], ["appraised_val", "Appraised"], ["assessed_val", "Assessed"],
    ].filter(([k]) => rows.some((r) => r[k] != null));
      // add up to 5 owner columns
      for (let i = 0; i < 5; i++) {
        const idx = i + 1;
        cols.push([`_owner_persons_${idx}_full`, `Owner ${idx} Full`]);
        cols.push([`_owner_persons_${idx}_first`, `Owner ${idx} First`]);
        cols.push([`_owner_persons_${idx}_last`, `Owner ${idx} Last`]);
      }
      // materialize owner person columns when mapping rows below
    const headers = cols.map(([, lbl]) => lbl);
    const mapped = rows.map((r) => {
      const extra: Record<string, any> = {};
      (r._owner_persons || []).slice(0, 5).forEach((p: any, i: number) => {
        const n = i + 1;
        extra[`_owner_persons_${n}_full`] = p.full;
        extra[`_owner_persons_${n}_first`] = p.first;
        extra[`_owner_persons_${n}_last`] = p.last;
      });
      return Object.fromEntries(cols.map(([k, lbl]) => [
        lbl,
        ["market_value","appraised_val","assessed_val"].includes(k as string) ? formatUSD(r[k]) : (extra[k as string] ?? r[k]),
      ]));
    });
    exportCSV(mapped as any, headers, filename);
  }

  // =================================================================
  //                           DATA LAB UI
  // =================================================================
  const [labOpen, setLabOpen] = useState(false);
  const [labScope, setLabScope] = useState<"selected" | "filtered" | "austin787" | "allTravis" | "custom">("filtered");
  const [labCustomZips, setLabCustomZips] = useState("");
  const [labOwnerScope, setLabOwnerScope] = useState<OwnerScope>("both");

  // tiles toggles (extensible)
  const [showKPIs, setShowKPIs] = useState(true);
  const [showValueHist, setShowValueHist] = useState(true);
  const [showAcreHist, setShowAcreHist] = useState(false);
  const [showLandUse, setShowLandUse] = useState(true);
  const [showTopOwners, setShowTopOwners] = useState(true);
  const [showTopZips, setShowTopZips] = useState(true);

  // DataLab state
  const [labLoading, setLabLoading] = useState(false);
  const [labError, setLabError] = useState<string | null>(null);
  const abortLabRef = useRef<AbortController | null>(null);

  // results
  const [kpi, setKpi] = useState<{ total: number; business: number; sumVal: number; avgVal?: number; medianValEstimate?: number; topOwnerShare?: { owner: string; share: number } | null; topZipShare?: { zip: string; share: number } | null } | null>(null);
  const [histVal, setHistVal] = useState<{ label: string; count: number }[]>([]);
  const [histAcres, setHistAcres] = useState<{ label: string; count: number }[]>([]);
  const [landUse, setLandUse] = useState<{ name: string; count: number }[]>([]);
  const [owners, setOwners] = useState<{ owner: string; parcels: number; total: number }[]>([]);
  const [zipLeaders, setZipLeaders] = useState<{ zip: string; parcels: number; total: number }[]>([]);

  // Lab views (localStorage)
  type LabView = {
    name: string;
    scope: typeof labScope;
    owner: OwnerScope;
    customZips?: string[];
    tiles: Record<string, boolean>;
  };
  const [savedViews, setSavedViews] = useState<LabView[]>(() => {
    try { return JSON.parse(localStorage.getItem("dataLabViews") || "[]"); } catch { return []; }
  });
  function saveViews(v: LabView[]) { localStorage.setItem("dataLabViews", JSON.stringify(v)); setSavedViews(v); }

  function applyView(v: LabView) {
    setLabScope(v.scope); setLabOwnerScope(v.owner);
    setLabCustomZips((v.customZips || []).join(", "));
    setShowKPIs(!!v.tiles.kpi); setShowValueHist(!!v.tiles.valueHist); setShowAcreHist(!!v.tiles.acreHist);
    setShowLandUse(!!v.tiles.landUse); setShowTopOwners(!!v.tiles.topOwners); setShowTopZips(!!v.tiles.topZips);
  }
  function persistCurrentView(name: string) {
    const view: LabView = {
      name,
      scope: labScope,
      owner: labOwnerScope,
      customZips: labScope === "custom" ? labCustomZips.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean) : [],
      tiles: {
        kpi: showKPIs, valueHist: showValueHist, acreHist: showAcreHist, landUse: showLandUse, topOwners: showTopOwners, topZips: showTopZips,
      },
    };
    saveViews([...savedViews.filter((x) => x.name !== name), view]);
  }
  function deleteView(name: string) { saveViews(savedViews.filter((x) => x.name !== name)); }

  // Build ZIP list per scope
  const labZipList: ZipRow[] = useMemo(() => {
    if (labScope === "selected") return zips.filter((z) => selected.includes(z.zip));
    if (labScope === "filtered") return sortedZips;
    if (labScope === "austin787") return zips.filter((z) => z.zip.startsWith("787"));
    if (labScope === "custom") {
      const norm = Array.from(new Set(labCustomZips.split(/[\s,;]+/).map(zip5).filter(Boolean) as string[]));
      const m = new Map(zips.map((z) => [z.zip, z.count]));
      return norm.map((zip) => ({ zip, count: m.get(zip) ?? 0 }));
    }
    // allTravis -> all known zips
    return zips;
  }, [labScope, labCustomZips, zips, selected, sortedZips]);

  // WHERE builder
  function buildZipWhere(zs: ZipRow[], fallbackAll: boolean) {
    if (!zs.length) return fallbackAll ? "1=1" : "1=0";
    // For "allTravis", don't emit a giant OR; just 1=1
    if (labScope === "allTravis") return "1=1";
    const ors = zs.map((z) => `situs_zip LIKE '${z.zip}%'`).join(" OR ");
    return `(${ors})`;
  }

  // Histogram helper (batched counts per range)
  async function histogramCounts(field: string, bins: Array<{ lo?: number; hi?: number; label: string }>, baseWhere: string, ownerClause: string, signal: AbortSignal) {
    const out: { label: string; count: number }[] = [];
    for (const b of bins) {
      let w = `(${baseWhere}) AND (${ownerClause})`;
      if (b.lo != null) w += ` AND ${field} > ${b.lo}`;
      if (b.hi != null) w += ` AND ${field} <= ${b.hi}`;
      const res = await fetchJSONWithRetry(CONFIG.parcelsLayer + "/query", { f: "json", where: w, returnCountOnly: true }, signal);
      out.push({ label: b.label, count: Number(res.count || 0) });
    }
    return out;
  }

  // GroupBy helper
  async function groupBy(field: string, baseWhere: string, ownerClause: string, signal: AbortSignal, opts?: { statField?: string; statType?: "sum" | "avg" | "count"; take?: number }) {
    const statField = opts?.statField || "OBJECTID";
    const statType = opts?.statType || "count";
    const alias = statType === "count" ? "c" : (statType === "sum" ? "s" : "a");
    const body: any = {
      f: "json",
      where: `(${baseWhere}) AND (${ownerClause})`,
      outFields: field,
      groupByFieldsForStatistics: field,
      outStatistics: [{ statisticType: statType, onStatisticField: statField, outStatisticFieldName: alias }],
      returnGeometry: false,
      orderByFields: `${alias} DESC`,
      resultRecordCount: Math.min(opts?.take ?? 100, 1000),
    };
    const res = await fetchJSONWithRetry(CONFIG.parcelsLayer + "/query", body, signal);
    return (res.features || []).map((f: any) => ({ key: f.attributes[field], value: Number(f.attributes[alias] || 0) }));
  }

  async function runDataLab() {
    const ctrl = new AbortController();
    abortLabRef.current = ctrl;
    try {
      setLabLoading(true); setLabError(null);

      const baseWhere = buildZipWhere(labZipList, labScope === "allTravis" || labScope === "austin787");
      const ownerClause = ownerScopeWhere(labOwnerScope);

      // KPIs
      const totalP = await fetchJSONWithRetry(CONFIG.parcelsLayer + "/query", { f: "json", where: `(${baseWhere}) AND (${ownerClause})`, returnCountOnly: true }, ctrl.signal);
      const bizP = await fetchJSONWithRetry(CONFIG.parcelsLayer + "/query", { f: "json", where: `(${baseWhere}) AND (${ownerScopeWhere("business")})`, returnCountOnly: true }, ctrl.signal);
      const sumValRes = await fetchJSONWithRetry(CONFIG.parcelsLayer + "/query", {
        f: "json",
        where: `(${baseWhere}) AND (${ownerClause})`,
        outStatistics: [{ statisticType: "sum", onStatisticField: "market_value", outStatisticFieldName: "s" }],
        returnGeometry: false,
      }, ctrl.signal);
      const total = Number(totalP.count || 0);
      const business = Number(bizP.count || 0);
      const sumVal = Number(sumValRes?.features?.[0]?.attributes?.s || 0);
  // avg value
  const avgVal = total ? sumVal / total : 0;
  setKpi({ total, business, sumVal, avgVal });

      // Histograms
      if (showValueHist) {
        const binsVal = [
          { hi: 250000, label: "≤ $250k" },
          { lo: 250000, hi: 500000, label: "$250k–$500k" },
          { lo: 500000, hi: 1000000, label: "$500k–$1m" },
          { lo: 1000000, hi: 2000000, label: "$1m–$2m" },
          { lo: 2000000, label: ">$2m" },
        ];
        const hv = await histogramCounts("market_value", binsVal, baseWhere, ownerClause, ctrl.signal);
        setHistVal(hv);
        // estimate median roughly from bins
        try {
          // import helper inline to avoid circular issues
          // ranges mirror binsVal (lo/hi)
          const ranges = [
            { hi: 250000 }, { lo: 250000, hi: 500000 }, { lo: 500000, hi: 1000000 }, { lo: 1000000, hi: 2000000 }, { lo: 2000000 },
          ];
          const { approxMedianFromBins } = await import("./lib/utils");
          const medianEst = approxMedianFromBins(hv, ranges);
          setKpi((k) => k ? ({ ...k, medianValEstimate: medianEst }) : { total, business, sumVal, avgVal: total ? sumVal / total : 0, medianValEstimate: medianEst });
        } catch {
          // ignore
        }
      } else setHistVal([]);

      if (showAcreHist) {
        const binsAcres = [
          { hi: 0.2, label: "≤ 0.2" }, { lo: 0.2, hi: 0.5, label: "0.2–0.5" },
          { lo: 0.5, hi: 1, label: "0.5–1" }, { lo: 1, hi: 2, label: "1–2" },
          { lo: 2, label: "> 2" },
        ];
        setHistAcres(await histogramCounts("tcad_acres", binsAcres, baseWhere, ownerClause, ctrl.signal));
      } else setHistAcres([]);

      // Land use composition
      if (showLandUse) {
        const list = await groupBy("land_type_desc", baseWhere, ownerClause, ctrl.signal, { statType: "count", take: 50 });
        // Normalize undefined/empty into "(Unknown)"
        const norm = list.map((x: any) => ({ name: x.key || "(Unknown)", count: x.value }));
        setLandUse(norm.sort((a: any, b: any) => b.count - a.count).slice(0, 20));
      } else setLandUse([]);

      // Top owners (by value and count)
      if (showTopOwners) {
        const topCount = await groupBy("py_owner_name", baseWhere, ownerClause, ctrl.signal, { statType: "count", take: 400 });
        const topValue = await groupBy("py_owner_name", baseWhere, ownerClause, ctrl.signal, { statType: "sum", statField: "market_value", take: 400 });
        // Build maps by normalized owner key
        const countMap = new Map<string, number>();
        const valueMap = new Map<string, number>();
        const displayMap = new Map<string, string>();

        for (const t of topCount || []) {
          const name = t.key || "";
          const key = normalizeOwnerKey(name) || name.toLowerCase();
          countMap.set(key, (countMap.get(key) || 0) + (t.value || 0));
          if (!displayMap.has(key)) displayMap.set(key, name);
        }
        for (const t of topValue || []) {
          const name = t.key || "";
          const key = normalizeOwnerKey(name) || name.toLowerCase();
          valueMap.set(key, (valueMap.get(key) || 0) + (t.value || 0));
          if (!displayMap.has(key)) displayMap.set(key, name);
        }

        let mergedAgg = Array.from(new Set([...countMap.keys(), ...valueMap.keys()])).map((key) => ({
          owner_key: key,
          owner: displayMap.get(key) || key,
          parcels: countMap.get(key) || 0,
          total: valueMap.get(key) || 0,
        }));

        // If residential scope requested, filter to person-like keys
        if (labOwnerScope === "residential") {
          mergedAgg = mergedAgg.filter((m) => isLikelyPersonName(m.owner));
        }

        mergedAgg = mergedAgg.sort((a, b) => (b.total - a.total || b.parcels - a.parcels)).slice(0, 40);
        const merged = mergedAgg.slice(0, 20).map((m) => ({ owner: m.owner, parcels: m.parcels, total: m.total }));
        setOwners(merged);
        // compute top owner share
        if (merged.length) {
          const top = merged[0];
          const share = sumVal ? top.total / sumVal : 0;
          setKpi((k) => k ? ({ ...k, topOwnerShare: { owner: top.owner, share } }) : ({ total, business, sumVal, avgVal: total ? sumVal / total : 0, topOwnerShare: { owner: top.owner, share } }));
        }
      } else setOwners([]);

      // Top ZIPs (aggregate to ZIP5)
      if (showTopZips) {
        const rawZ = await groupBy("situs_zip", baseWhere, ownerClause, ctrl.signal, { statType: "count", take: 1000 });
        const agg = new Map<string, { parcels: number; total: number }>();
        for (const r of rawZ) {
          const z = zip5(r.key);
          if (!z) continue;
          const cur = agg.get(z) || { parcels: 0, total: 0 };
          cur.parcels += r.value; agg.set(z, cur);
        }
        // sum market value per ZIP
        const rawZSum = await groupBy("situs_zip", baseWhere, ownerClause, ctrl.signal, { statType: "sum", statField: "market_value", take: 1000 });
        for (const r of rawZSum) {
          const z = zip5(r.key);
          if (!z) continue;
          const cur = agg.get(z) || { parcels: 0, total: 0 };
          cur.total += r.value; agg.set(z, cur);
        }
        const arr = Array.from(agg.entries()).map(([zip, v]) => ({ zip, parcels: v.parcels, total: v.total }));
        const zl = arr.sort((a, b) => (b.parcels - a.parcels)).slice(0, 25);
        setZipLeaders(zl);
        if (zl.length) {
          const top = zl[0];
          const share = sumVal ? top.total / sumVal : 0;
          setKpi((k) => k ? ({ ...k, topZipShare: { zip: top.zip, share } }) : ({ total, business, sumVal, avgVal: total ? sumVal / total : 0, topZipShare: { zip: top.zip, share } }));
        }
      } else setZipLeaders([]);

    } catch (e: any) {
      if (e?.name !== "AbortError") setLabError(e?.message || String(e));
    } finally {
      setLabLoading(false);
      abortLabRef.current = null;
    }
  }

  // use exportTile from utils

  // Drill-ins
  function drillOwner(owner: string) {
    const targetZip = labZipList[0]?.zip || sortedZips[0]?.zip || zips[0]?.zip;
    if (!targetZip) return;
    expandZip(targetZip);
    setParcelFilter(owner);
  }
  function drillZip(zip: string) { expandZip(zip); }

  // BarList component is imported from components/BarList

  // =================================================================
  // UI
  // =================================================================
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white dark:from-slate-900 dark:to-slate-950 text-slate-800 dark:text-slate-100 p-6 font-sans">
      <h1 className="text-3xl font-extrabold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-emerald-600 to-indigo-600">
        Austin/Travis ZIPs with Parcel Counts
      </h1>

      {loading && <p>Loading…</p>}
      {error && <p className="text-red-600">Error: {error}</p>}

      {route === "/analytics" && (
        <ErrorBoundary>
          <React.Suspense fallback={<div className="p-4">Loading analytics…</div>}>
            <Analytics quickStats={{ owners, zips: zipLeaders }} onRefresh={() => runDataLab()} />
          </React.Suspense>
        </ErrorBoundary>
      )}

      {route !== "/analytics" && !loading && !error && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex flex-wrap gap-3 items-center rounded-2xl border bg-white/80 dark:bg-slate-900/50 backdrop-blur p-4 shadow-sm dark:border-slate-700">
            <input
              type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by ZIP"
              className="border rounded-xl px-3 py-2 bg-white/70 dark:bg-slate-800/60 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition"
            />
            <button onClick={toggleAll} className="px-3 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 transition">
              {selected.length === sortedZips.length ? "Clear All" : "Select All"}
            </button>
            <button
              onClick={() => setSortByCount((s) => !s)}
              className="px-3 py-2 rounded-xl border border-slate-300 hover:bg-emerald-50/60 dark:hover:bg-emerald-900/20 dark:border-slate-700 transition"
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
              onClick={() => setLabOpen(true)}
              className="ml-auto px-3 py-2 rounded-xl bg-amber-600 text-white hover:bg-amber-500 shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-400 transition"
            >
              Open Data Lab
            </button>

            <button
              onClick={() => (location.hash = "#/analytics")}
              className="px-3 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 dark:border-slate-700 transition"
            >
              Analytics
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
                    className={`odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-700 ${selected.includes(z.zip) ? "ring-1 ring-emerald-300 dark:ring-emerald-800" : ""}`}
                  >
                    <td className="px-2 py-1">
                      <input type="checkbox" checked={selected.includes(z.zip)} onChange={() => toggle(z.zip)} />
                    </td>
                    <td className="px-2 py-1 font-mono">{z.zip}</td>
                    <td className="px-2 py-1 text-right font-semibold">{z.count.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right">
                      <button className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-500" onClick={() => expandZip(z.zip)}>
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
                <button onClick={() => setActiveTab("business")} className={`px-3 py-1 rounded ${activeTab === "business" ? "bg-indigo-600 text-white" : "bg-slate-200 dark:bg-slate-700"}`}>Business</button>
                <button onClick={() => setActiveTab("residential")} className={`px-3 py-1 rounded ${activeTab === "residential" ? "bg-indigo-600 text-white" : "bg-slate-200 dark:bg-slate-700"}`}>Residential</button>
                <input
                  value={parcelFilter} onChange={(e) => setParcelFilter(e.target.value)} placeholder="Search owner / address / id"
                  className="border border-slate-400 dark:border-slate-600 rounded px-2 py-1 text-sm bg-white dark:bg-slate-800"
                />
                <select value={parcelSort.key} onChange={(e) => setParcelSort({ key: e.target.value, dir: parcelSort.dir })} className="border rounded px-2 py-1 text-sm bg-white dark:bg-slate-800">
                  <option value="py_owner_name">Owner</option><option value="situs_address">Situs</option><option value="PROP_ID">Parcel ID</option><option value="market_value">Market Value</option><option value="tcad_acres">Acres</option>
                </select>
                <button className="border rounded px-2 py-1 text-sm" onClick={() => setParcelSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}>
                  {parcelSort.dir === "asc" ? "Asc" : "Desc"}
                </button>
                <button className="border rounded px-2 py-1 text-sm bg-blue-600 text-white" onClick={() => exportCurrentPage(`${expandedZip}_${activeTab}_page${page}.csv`)}>
                  Export Current Page
                </button>
                <button onClick={() => setExpandedZip(null)} className="ml-2 text-red-600 hover:underline">Close</button>
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-white dark:bg-slate-900 custom-scroll">
              {parcelLoading && <p className="p-4">Loading parcels…</p>}
              {parcelError && <p className="p-4 text-red-600">{parcelError}</p>}
              {!parcelLoading && !parcelError && (
                <>
                  <table className="min-w-full text-sm">
                    <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 font-semibold shadow-sm">
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
                        <tr key={idx} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-700">
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
                    <span className="text-sm">{totalCount != null ? `${totalCount.toLocaleString()} rows • ` : ""}Page {page} / {totalPages}</span>
                    <button className="px-2 py-1 border rounded disabled:opacity-50" disabled={page <= 1 || parcelLoading} onClick={() => loadPage(Math.max(1, page - 1))}>Prev</button>
                    <button className="px-2 py-1 border rounded disabled:opacity-50" disabled={page >= totalPages || parcelLoading} onClick={() => loadPage(Math.min(totalPages, page + 1))}>Next</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------------------- DATA LAB ---------------------- */}
      {labOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/40" onClick={() => !labLoading && setLabOpen(false)} />
          <div className="w-full max-w-5xl bg-white dark:bg-slate-900 h-full overflow-auto shadow-2xl slide-in-right">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Data Lab</h2>
              <div className="flex gap-2 items-center">
                <button className="tag" onClick={() => runDataLab()} disabled={labLoading}>{labLoading ? "Refreshing…" : "Refresh"}</button>
                <button
                  className="tag"
                  onClick={() => {
                    const name = prompt("Save view as…");
                    if (name) persistCurrentView(name);
                  }}
                >
                  Save View
                </button>
                <button className="text-red-600 hover:underline disabled:opacity-50" disabled={labLoading} onClick={() => setLabOpen(false)}>Close</button>
              </div>
            </div>

            {/* Controls */}
            <div className="p-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              <div className="tile">
                <div className="tile-title">Scope</div>
                <div className="flex flex-wrap gap-2 mb-2">
                  <button className={`tag ${labScope === "selected" ? "tag-active" : ""}`} onClick={() => setLabScope("selected")}>Selected</button>
                  <button className={`tag ${labScope === "filtered" ? "tag-active" : ""}`} onClick={() => setLabScope("filtered")}>Filtered</button>
                  <button className={`tag ${labScope === "austin787" ? "tag-active" : ""}`} onClick={() => setLabScope("austin787")}>Austin 787xx</button>
                  <button className={`tag ${labScope === "allTravis" ? "tag-active" : ""}`} onClick={() => setLabScope("allTravis")}>All Travis</button>
                  <button className={`tag ${labScope === "custom" ? "tag-active" : ""}`} onClick={() => setLabScope("custom")}>Custom</button>
                </div>
                {labScope === "custom" && (
                  <textarea
                    className="w-full h-20 border rounded-xl p-2 bg-white/70 dark:bg-slate-800/60"
                    placeholder="ZIPs separated by commas or spaces (e.g., 78701, 78702, 78704)…"
                    value={labCustomZips}
                    onChange={(e) => setLabCustomZips(e.target.value)}
                  />
                )}
                <div className="text-xs text-slate-500 mt-2">ZIPs in scope: {labZipList.length}</div>
              </div>

              <div className="tile">
                <div className="tile-title">Owner Type</div>
                <div className="flex gap-2">
                  <button className={`tag ${labOwnerScope === "both" ? "tag-active" : ""}`} onClick={() => setLabOwnerScope("both")}>Both</button>
                  <button className={`tag ${labOwnerScope === "business" ? "tag-active" : ""}`} onClick={() => setLabOwnerScope("business")}>Business</button>
                  <button className={`tag ${labOwnerScope === "residential" ? "tag-active" : ""}`} onClick={() => setLabOwnerScope("residential")}>Residential</button>
                </div>
                <div className="text-xs text-slate-500 mt-2">Server-side approximation using name patterns.</div>
              </div>

              <div className="tile">
                <div className="tile-title">Tiles</div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showKPIs} onChange={(e) => setShowKPIs(e.target.checked)} /> KPIs</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showValueHist} onChange={(e) => setShowValueHist(e.target.checked)} /> Value histogram</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showAcreHist} onChange={(e) => setShowAcreHist(e.target.checked)} /> Acres histogram</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showLandUse} onChange={(e) => setShowLandUse(e.target.checked)} /> Land use</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showTopOwners} onChange={(e) => setShowTopOwners(e.target.checked)} /> Top owners</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showTopZips} onChange={(e) => setShowTopZips(e.target.checked)} /> Top ZIPs</label>
                </div>
              </div>

              {/* Saved views */}
              <div className="tile md:col-span-2 lg:col-span-3">
                <div className="tile-title">Saved Views</div>
                <div className="flex flex-wrap gap-2">
                  {savedViews.map((v) => (
                    <div key={v.name} className="view-chip">
                      <button className="link" onClick={() => applyView(v)}>{v.name}</button>
                      <button className="del" onClick={() => deleteView(v.name)} title="Delete">×</button>
                    </div>
                  ))}
                  {!savedViews.length && <div className="text-sm text-slate-500">No saved views yet.</div>}
                </div>
              </div>
            </div>

            {/* RESULTS */}
            <div className="p-4 space-y-4">
              {labError && <div className="text-rose-600 text-sm">{labError}</div>}
              {labLoading && <div className="text-sm">Crunching numbers…</div>}

              {/* KPIs */}
              {showKPIs && kpi && (
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="kpi"><div className="kpi-label">Parcels in scope</div><div className="kpi-value">{kpi.total.toLocaleString()}</div></div>
                  <div className="kpi"><div className="kpi-label">Business share</div><div className="kpi-value">{kpi.total ? Math.round((kpi.business / kpi.total) * 100) : 0}%</div></div>
                  <div className="kpi"><div className="kpi-label">Sum market value</div><div className="kpi-value">{formatUSD(kpi.sumVal)}</div></div>
                </div>
              )}

              {/* Value histogram */}
              {showValueHist && !!histVal.length && (
                <div className="chart-card">
                  <div className="chart-head">
                    <div className="chart-title">Market value distribution</div>
                    <button className="mini-btn" onClick={() => exportTile(histVal.map(d => ({ Bucket: d.label, Parcels: d.count })), "value_histogram.csv")}>Export data</button>
                  </div>
                  <BarList data={histVal.map((h) => ({ label: h.label, value: h.count }))} />
                </div>
              )}

              {/* Acre histogram */}
              {showAcreHist && !!histAcres.length && (
                <div className="chart-card">
                  <div className="chart-head">
                    <div className="chart-title">Acres distribution</div>
                    <button className="mini-btn" onClick={() => exportTile(histAcres.map(d => ({ Bucket: d.label, Parcels: d.count })), "acres_histogram.csv")}>Export data</button>
                  </div>
                  <BarList data={histAcres.map((h) => ({ label: h.label, value: h.count }))} />
                </div>
              )}

              {/* Land use composition */}
              {showLandUse && !!landUse.length && (
                <div className="chart-card">
                  <div className="chart-head">
                    <div className="chart-title">Land use composition (top)</div>
                    <button className="mini-btn" onClick={() => exportTile(landUse.map(d => ({ "Land Use": d.name, Parcels: d.count })), "land_use.csv")}>Export data</button>
                  </div>
                  <BarList data={landUse.map((l) => ({ label: l.name, value: l.count }))} maxBars={14} />
                </div>
              )}

              {/* Top owners */}
              {showTopOwners && !!owners.length && (
                <div className="chart-card">
                  <div className="chart-head">
                    <div className="chart-title">Top owners</div>
                    <div className="flex gap-2">
                      <button className="mini-btn" onClick={() => exportTile(owners.map(o => ({ Owner: o.owner, Parcels: o.parcels, "Total Value": o.total })), "top_owners.csv")}>Export data</button>
                    </div>
                  </div>
                  <BarList
                    data={owners.map((o) => ({ label: o.owner, value: o.parcels, hint: `${o.owner} • ${formatUSD(o.total)}` }))}
                    onClick={(label) => drillOwner(label)}
                    maxBars={15}
                  />
                </div>
              )}

              {/* Top ZIPs */}
              {showTopZips && !!zipLeaders.length && (
                <div className="chart-card">
                  <div className="chart-head">
                    <div className="chart-title">Top ZIPs by parcels</div>
                    <div className="flex gap-2">
                      <button className="mini-btn" onClick={() => exportTile(zipLeaders.map(z => ({ ZIP: z.zip, Parcels: z.parcels, "Total Value": z.total })), "top_zips.csv")}>Export data</button>
                    </div>
                  </div>
                  <BarList
                    data={zipLeaders.map((z) => ({ label: z.zip, value: z.parcels, hint: `${z.zip} • ${formatUSD(z.total)}` }))}
                    onClick={(label) => drillZip(label)}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
