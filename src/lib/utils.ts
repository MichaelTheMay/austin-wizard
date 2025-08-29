export function zip5(v: any): string | null {
  if (v == null) return null;
  const s = String(v);
  const only = s.replace(/\D/g, "");
  if (only.length < 5) return null;
  const five = only.slice(0, 5);
  return five.length === 5 ? five : null;
}

export function cleanZip(zip: string): string | null {
  return zip5(zip);
}

export function formatUSD(n: any) {
  const x = Number(n);
  if (!isFinite(x)) return "";
  try {
    return x.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(x).toLocaleString()}`;
  }
}

export function exportCSV(rows: Record<string, any>[], headers: string[], filename: string) {
  if (!rows.length) return;
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export const BIZ_LIKE_TOKENS = [
  " LLC","INC"," CORP"," CORPORATION"," LTD"," LP"," L.P"," LLP"," PLLC"," CO ",
  " COMPANY"," HOLDINGS"," HLDGS"," PARTNERS"," PARTNERSHIP"," TRUST"," TR",
  " INVESTMENTS"," PROPERTIES"," MGMT"," MANAGEMENT"," ENTERPRISE"," FOUNDATION",
];

export function classifyOwner(name: string): "business" | "residential" {
  if (!name) return "residential";
  const u = name.toUpperCase();
  return BIZ_LIKE_TOKENS.some((t) => u.includes(t)) ? "business" : "residential";
}

export function ownerScopeWhere(scope: "both" | "business" | "residential") {
  if (scope === "both") return "1=1";
  const ors = BIZ_LIKE_TOKENS.map((t) => `UPPER(py_owner_name) LIKE '%${t.replace(/'/g, "''")}%'`).join(" OR ");
  if (scope === "business") return `(${ors})`;
  return `(py_owner_name IS NULL OR NOT (${ors}))`;
}

export function exportTile(rows: any[], filename: string) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  exportCSV(rows, headers, filename);
}

// Small analytics helpers
export function formatPercent(part: number, total: number, digits = 0) {
  if (!total) return "0%";
  const pct = (part / total) * 100;
  return `${pct.toFixed(digits)}%`;
}

/**
 * Approximate median from binned histogram counts.
 * bins: [{ label, count }]
 * ranges: array with same length where each item is { lo?: number; hi?: number }
 * Returns approximate median numeric value (midpoint of bin containing median)
 */
export function approxMedianFromBins(
  bins: { label: string; count: number }[],
  ranges: Array<{ lo?: number; hi?: number }>
): number {
  const total = bins.reduce((s, b) => s + (b.count || 0), 0);
  if (!total) return 0;
  const half = total / 2;
  let cum = 0;
  for (let i = 0; i < bins.length; i++) {
    cum += bins[i].count || 0;
    if (cum >= half) {
      const r = ranges[i] || {};
      const lo = r.lo ?? 0;
      const hi = r.hi ?? lo;
      if (hi === undefined || hi <= lo) return lo;
      return (lo + hi) / 2;
    }
  }
  return 0;
}

// Heuristics to detect an individual person's name vs a business/entity name.
export function isLikelyPersonName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = String(raw).trim();
  if (!s) return false;
  const u = s.toUpperCase();
  // Reject common placeholders or signals
  const negative = ["UNKNOWN", "UNKNOWN OWNER", "SEE DEED", "VACANT", "MULTIPLE", "DECEASED", "C/O", "%C/O%", "ATTN", "PO BOX", "P O BOX", "TRUSTEE", "ESTATE", "BANK", "ASSOCIATION", "HOA", "REMAINDER", "REMAINDERMAN", "UNIT#", "LOT#"];
  for (const n of negative) if (u.includes(n)) return false;

  // Reject if contains business tokens
  for (const t of BIZ_LIKE_TOKENS) if (u.includes(t.trim())) return false;

  // Remove punctuation and extra whitespace
  const cleaned = s.replace(/[.,()\-\/]+/g, " ").replace(/\s+/g, " ").trim();
  const parts = cleaned.split(" ").filter(Boolean);
  // Require at least two name-like tokens (first + last)
  if (parts.length < 2) return false;

  // Reject if any part contains digits or typical address tokens
  for (const p of parts) {
    if (/\d/.test(p)) return false;
    if (/^(LOT|BLK|UNIT|STE|APT|#)$/i.test(p)) return false;
  }

  // Reject if looks like an organization abbreviation (all short tokens)
  const shortTokens = parts.filter((p) => p.length <= 2);
  if (shortTokens.length >= parts.length - 1) return false;

  // Accept as person name
  return true;
}
  