import React from "react";

type Item = { label: string; value: number; hint?: string };
export const BarList: React.FC<{ data: Item[]; onClick?: (label: string) => void; maxBars?: number }> = ({ data, onClick, maxBars = 12 }) => {
  const top = data.slice(0, maxBars);
  const max = Math.max(1, ...top.map((d) => d.value));
  return (
    <div className="barlist">
      {top.map((d) => (
        <div key={d.label} className={`barrow ${onClick ? "clickable" : ""}`} onClick={() => onClick?.(d.label)}>
          <div className="barlabel" title={d.hint || d.label}>{d.label}</div>
          <div className="bartrack">
            <div className="barfill" style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
          <div className="barvalue">{d.value.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
};

export default BarList;
