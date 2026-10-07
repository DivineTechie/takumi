import React, { useState, useMemo } from 'react';
import { useTranslation } from '../../i18n';
import type { MatrixTrainee, MatrixSkill, MatrixCell } from '../../lib/api';

interface SkillMatrixTableProps {
  trainees: MatrixTrainee[];
  skills: MatrixSkill[];
  cells: MatrixCell[];
  onSelectCell?: (traineeUid: string, skillId: string) => void;
}

export const SkillMatrixTable: React.FC<SkillMatrixTableProps> = ({
  trainees,
  skills,
  cells,
  onSelectCell,
}) => {
  const { t } = useTranslation();
  const [filterQuery, setFilterQuery] = useState('');

  // Lookup map: `${uid}:${skill_id}` -> cell
  const cellMap = useMemo(() => {
    const map = new Map<string, MatrixCell>();
    cells.forEach((c) => {
      map.set(`${c.uid}:${c.skill_id}`, c);
    });
    return map;
  }, [cells]);

  const filteredTrainees = useMemo(() => {
    if (!filterQuery.trim()) return trainees;
    const q = filterQuery.toLowerCase();
    return trainees.filter((tr) => tr.first_name.toLowerCase().includes(q));
  }, [trainees, filterQuery]);

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 sm:p-5 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[18px] font-bold text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary-container text-[22px]">
              group
            </span>
            {t('dashboard_team_matrix')}
          </h2>
          <span className="text-[13px] text-on-surface-variant">
            {trainees.length} {t('dashboard_trainee')} • {skills.length} lessons
          </span>
        </div>

        <div className="relative min-w-[200px]">
          <span className="material-symbols-outlined absolute left-3 top-2.5 text-on-surface-variant text-[18px]">
            search
          </span>
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder={t('dashboard_filter_all') || 'Filter trainees…'}
            className="w-full bg-surface-container border border-outline-variant rounded-xl pl-9 pr-3 py-2 text-[14px] text-on-surface focus:outline-none focus:ring-1 focus:ring-primary-container placeholder:text-on-surface-variant/60"
          />
        </div>
      </div>

      <div className="overflow-x-auto -mx-4 sm:mx-0">
        <table className="w-full text-left border-collapse min-w-[500px]">
          <thead>
            <tr className="border-b border-outline-variant/80 text-[13px] font-bold text-on-surface-variant uppercase tracking-wider">
              <th className="py-3 px-4 bg-surface-container-low sticky left-0 z-10 w-[180px]">
                {t('dashboard_trainee')}
              </th>
              {skills.map((skill) => (
                <th key={skill.id} className="py-3 px-4 min-w-[200px]">
                  {skill.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/40">
            {filteredTrainees.length === 0 ? (
              <tr>
                <td
                  colSpan={skills.length + 1}
                  className="py-8 text-center text-on-surface-variant font-medium text-[14px]"
                >
                  {t('dashboard_no_data')}
                </td>
              </tr>
            ) : (
              filteredTrainees.map((trainee) => (
                <tr
                  key={trainee.uid}
                  className="hover:bg-surface-container/40 transition-colors"
                >
                  <td className="py-3.5 px-4 font-bold text-on-surface text-[15px] bg-surface-container-low sticky left-0 z-10 whitespace-nowrap">
                    {trainee.first_name}
                  </td>
                  {skills.map((skill) => {
                    const cell = cellMap.get(`${trainee.uid}:${skill.id}`);
                    const status = cell?.status || 'not_started';
                    const sessions = cell?.sessions || 0;
                    const mistakesTrend = cell?.mistakes_trend || [];

                    return (
                      <td key={skill.id} className="py-3 px-4">
                        <button
                          type="button"
                          onClick={() => onSelectCell?.(trainee.uid, skill.id)}
                          className="w-full text-left p-2 rounded-xl border border-transparent hover:border-outline-variant hover:bg-surface-container focus:outline-none transition-all cursor-pointer group"
                        >
                          <div className="flex items-center justify-between gap-2">
                            {status === 'certified' && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] font-bold bg-success/15 text-success border border-success/30">
                                <span className="material-symbols-outlined text-[14px]">
                                  verified
                                </span>
                                {t('dashboard_certified')}
                              </span>
                            )}
                            {status === 'learning' && (
                              <div className="flex flex-col gap-1">
                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[12px] font-bold bg-primary-container/20 text-primary-container border border-primary-container/30">
                                  <span className="material-symbols-outlined text-[14px]">
                                    school
                                  </span>
                                  {t('dashboard_learning')} ({sessions})
                                </span>
                                {mistakesTrend && mistakesTrend.length > 0 ? (
                                  <div
                                    className="flex items-center gap-1 mt-0.5 px-1"
                                    title={`Recent mistakes: ${mistakesTrend.join(', ')}`}
                                  >
                                    <span className="text-[10px] text-on-surface-variant font-medium shrink-0">
                                      Mistakes:
                                    </span>
                                    <div className="flex items-end gap-1 h-3.5 pb-0.5">
                                      {mistakesTrend.map((m, idx) => (
                                        <span
                                          key={idx}
                                          className={`w-2 h-2 rounded-full shrink-0 ${
                                            m === 0
                                              ? 'bg-emerald-500'
                                              : m <= 2
                                              ? 'bg-amber-400'
                                              : 'bg-rose-500'
                                          }`}
                                          style={{
                                            marginBottom: m === 0 ? '0px' : `${Math.min(m * 2, 5)}px`,
                                          }}
                                        />
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  <span className="text-[10px] text-on-surface-variant font-medium px-1 mt-0.5 block">
                                    {t('dashboard_no_mistakes')}
                                  </span>
                                )}
                              </div>
                            )}
                            {status === 'not_started' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-medium bg-surface-container-high text-on-surface-variant border border-outline-variant/60">
                                {t('dashboard_not_started')}
                              </span>
                            )}
                          </div>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
