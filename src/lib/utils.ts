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
