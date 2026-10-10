import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchUnits, type UnitSummary } from '../../lib/api';

/** Recent units with their status; opens the unit record and trace-back. Real data only. */

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'failed', label: 'Failed' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'on_hold', label: 'On hold' },
];

export const RecentUnits: React.FC = () => {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [units, setUnits] = useState<UnitSummary[] | null>(null);
  const [serial, setSerial] = useState('');

  useEffect(() => {
    let live = true;
    fetchUnits(filter || undefined)
      .then((u) => live && setUnits(u))
      .catch(() => live && setUnits([]));
    return () => {
      live = false;
    };
  }, [filter]);

  return (
    <div className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[18px] font-bold text-on-surface">Units</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (serial.trim()) navigate(`/units/${encodeURIComponent(serial.trim())}`);
          }}
          className="flex gap-2"
        >
          <input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="Find a serial"
            aria-label="Find a unit by serial"
            className="min-h-[44px] rounded-lg bg-surface-container px-3 font-mono text-sm border border-outline-variant"
          />
          <button type="submit" className="min-h-[44px] px-3 rounded-lg bg-surface-container-high text-sm font-bold">
            Open
          </button>
        </form>
      </div>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`min-h-[36px] px-3 rounded-full text-xs font-bold ${filter === f.key ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface-variant'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {units === null ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : units.length === 0 ? (
        <p className="text-sm text-on-surface-variant">No units yet. Units appear when a serial is entered at a station or an inspection.</p>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {units.slice(0, 20).map((u) => (
            <li key={u.id} className="py-2 flex items-center justify-between gap-2 text-sm">
              <Link to={`/units/${encodeURIComponent(u.id)}`} className="font-mono font-bold underline">
                {u.id}
              </Link>
              <span className="text-on-surface-variant text-xs">
                {u.stations} station(s) · {u.inspections} inspection(s) · {u.issues} issue(s)
              </span>
              <span className="text-xs font-bold">{u.status.replace('_', ' ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
