import React from "react";
import BarList from "../components/BarList";

const Analytics: React.FC<{ quickStats: any; onRefresh?: () => void; onBack?: () => void }> = ({ quickStats, onRefresh, onBack }) => {
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Analytics</h2>
        <div className="flex gap-2">
          <button className="px-3 py-1 rounded border" onClick={onBack}>Back</button>
          <button className="px-3 py-1 rounded bg-emerald-600 text-white" onClick={onRefresh}>Refresh</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <div className="card-title">Top Owners (sample)</div>
          {quickStats?.owners?.length ? <BarList data={quickStats.owners.map((o: any) => ({ label: o.owner, value: o.parcels }))} maxBars={12} /> : <div className="text-sm text-slate-500">Run Data Lab to populate</div>}
        </div>

        <div className="card">
          <div className="card-title">Top ZIPs (sample)</div>
          {quickStats?.zips?.length ? <BarList data={quickStats.zips.map((z: any) => ({ label: z.zip, value: z.parcels }))} /> : <div className="text-sm text-slate-500">Run Data Lab to populate</div>}
        </div>
      </div>
    </div>
  );
};

export default Analytics;