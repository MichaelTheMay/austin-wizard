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

// Split an owner string which may contain multiple individual names into
// an array of { first, last, full } pairs. Conservative: returns empty
// array when the input doesn't look like person names.
export function splitPersonNames(raw: string | null | undefined): { first: string; last: string; full: string }[] {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];

  // Normalize separators commonly used between co-owners
  const parts = s
    // replace common separators with pipe
    .replace(/\s+&\s+|\s+AND\s+|\s*\/\s*|;|\|/gi, "|")
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  const out: { first: string; middle?: string; last: string; full: string }[] = [];

  const suffixes = /\b(JR|SR|II|III|IV|V|MD|ESQ|PHD)\.?$/i;
  const titles = /^(MR|MRS|MS|DR|MISS)\.?/i;
  const particles = /^(DE|DA|DEL|LA|VAN|VON|MC|MAC|O')$/i;

  for (let part of parts) {
    // If the part looks like 'LAST, FIRST [MIDDLE]' convert to 'FIRST MIDDLE LAST'
    if (/,/.test(part)) {
      const pieces = part.split(",").map((x) => x.trim()).filter(Boolean);
      if (pieces.length >= 2) {
        const last = pieces[0];
        const first = pieces.slice(1).join(" ");
        part = `${first} ${last}`;
      }
    }

    // Remove enclosing parentheses or extraneous markers
    part = part.replace(/^\(+|\)+$/g, "").trim();

    // Skip if not person-like
    if (!isLikelyPersonName(part)) continue;

    // strip titles and suffixes
    part = part.replace(titles, "").replace(suffixes, "").trim();
    const tokens = part.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // Determine first / middle / last with some heuristics
    let first = "";
    let middle = "";
    let last = "";

    if (tokens.length === 1) {
      first = tokens[0];
      last = "";
    } else if (tokens.length === 2) {
      first = tokens[0];
      last = tokens[1];
    } else {
      // tokens length >=3
      // If second-to-last token looks like a particle (de, van, etc.), treat last two as compound last name
      const secondLast = tokens[tokens.length - 2];
      if (particles.test(secondLast)) {
        first = tokens[0];
        middle = tokens.slice(1, -2).join(" ");
        last = tokens.slice(-2).join(" ");
      } else {
        first = tokens[0];
        middle = tokens.slice(1, -1).join(" ");
        last = tokens[tokens.length - 1];
      }
    }

    out.push({ first, middle: middle || undefined, last, full: part });
  }

  return out as any;
}

// Produce a normalized owner key for deduplication: "first last" in lowercase without punctuation
export function normalizeOwnerKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const persons = splitPersonNames(raw);
  if (!persons.length) return "";
  const p = persons[0];
  const key = `${p.first || ""} ${p.last || ""}`.trim().toLowerCase();
  // remove punctuation
  return key.replace(/[^a-z0-9\s']/gi, "").replace(/\s+/g, " ");
}

// Normalize owner name: trim, collapse whitespace, remove excessive punctuation,
// and return a Title Case-ish cleaned string suitable for display/export.
export function normalizeOwnerName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  // Remove extra punctuation but preserve apostrophes and hyphens
  s = s.replace(/["#\$%\^&\*\+=<>\(\)\[\]\{\}:;~`]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Lowercase then Title Case each token
  s = s.toLowerCase();
  s = s.split(" ").map((t) => t.length > 0 ? (t[0].toUpperCase() + t.slice(1)) : t).join(" ");
  return s;
}

// Normalize address to collapse whitespace and standardize casing minimally
export function normalizeAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/[\t\n\r]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// Parse a numeric-like field (e.g., "$1,234,567" or "1,234.56") into a number.
export function parseNumber(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  let s = String(v);
  // strip currency symbols and spaces
  s = s.replace(/\$/g, "").replace(/,/g, "").trim();
  const n = Number(s);
  return isFinite(n) ? n : 0;
}
  