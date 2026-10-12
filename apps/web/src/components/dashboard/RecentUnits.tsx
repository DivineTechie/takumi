import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchUnits, type UnitSummary } from '../../lib/api';
import { useI18n } from '../../i18n';

/** Recent units with their status; opens the unit record and trace-back. Real data only. */

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'ops.units_filter_all' },
  { key: 'failed', label: 'ops.units_filter_failed' },
  { key: 'needs_review', label: 'ops.units_filter_needs_review' },
  { key: 'on_hold', label: 'ops.units_filter_on_hold' },
];

/** Unit statuses with a translation; anything else from the API is shown as it is. */
const UNIT_STATUSES = ['in_progress', 'passed', 'failed', 'needs_review', 'on_hold'];

export const RecentUnits: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
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
        <h3 className="text-[18px] font-bold text-on-surface">{t('ops.units_title')}</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (serial.trim()) navigate(`/units/${encodeURIComponent(serial.trim())}`);
          }}
          className="flex gap-2 min-w-0"
        >
          <input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder={t('ops.units_find_placeholder')}
            aria-label={t('ops.units_find_label')}
            className="min-w-0 min-h-[44px] rounded-lg bg-surface-container px-3 font-mono text-sm border border-outline-variant"
          />
          <button type="submit" className="min-h-[44px] px-3 rounded-lg bg-surface-container-high text-sm font-bold">
            {t('ops.units_open')}
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
            {t(f.label)}
          </button>
        ))}
      </div>
      {units === null ? (
        <p className="text-sm text-on-surface-variant">{t('ops.common_loading')}</p>
      ) : units.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{t('ops.units_empty')}</p>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {units.slice(0, 20).map((u) => (
            <li key={u.id} className="py-2 flex items-center justify-between gap-2 text-sm">
              <Link to={`/units/${encodeURIComponent(u.id)}`} className="font-mono font-bold underline">
                {u.id}
              </Link>
              <span className="text-on-surface-variant text-xs">
                {t('ops.units_counts', { stations: u.stations, inspections: u.inspections, issues: u.issues })}
              </span>
              <span className="text-xs font-bold">{UNIT_STATUSES.includes(u.status) ? t(`ops.units_status_${u.status}`) : u.status.replace('_', ' ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
