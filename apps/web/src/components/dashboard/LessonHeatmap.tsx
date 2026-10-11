import React from 'react';
import { useTranslation } from '../../i18n';
import type { MatrixSkill, SkillInsightsResponse } from '../../lib/api';

interface LessonHeatmapProps {
  skills: MatrixSkill[];
  selectedSkillId: string;
  onSelectSkill: (skillId: string) => void;
  insights: SkillInsightsResponse | null;
  loading: boolean;
}

export const LessonHeatmap: React.FC<LessonHeatmapProps> = ({
  skills,
  selectedSkillId,
  onSelectSkill,
  insights,
  loading,
}) => {
  const { t } = useTranslation();

  // Find step with highest mistake rate (must have mistake_rate > 0)
  const maxMistakeStep = React.useMemo(() => {
    if (!insights?.steps) return null;
    let highestRate = 0;
    let highestStep: number | null = null;
    for (const s of insights.steps) {
      if (s.mistake_rate !== null && s.mistake_rate > highestRate) {
        highestRate = s.mistake_rate;
        highestStep = s.n;
      }
    }
    return highestStep;
  }, [insights]);

  const completionRate = React.useMemo(() => {
    if (!insights?.totals || insights.totals.sessions === 0) return 0;
    return Math.round((insights.totals.completed / insights.totals.sessions) * 100);
  }, [insights]);

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 sm:p-5 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-[18px] font-bold text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined text-primary-container text-[22px]">
              analytics
            </span>
            {t('dashboard_lesson_insights')}
          </h2>
          <span className="text-[13px] text-on-surface-variant">
            {t('app.heatmap_subtitle')}
          </span>
        </div>

        {/* Skill Selector */}
        <div className="min-w-0 sm:min-w-[240px]">
          <select
            value={selectedSkillId}
            onChange={(e) => onSelectSkill(e.target.value)}
            className="w-full bg-surface-container border border-outline-variant text-on-surface text-[14px] font-semibold rounded-xl px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-primary-container cursor-pointer"
          >
            {skills.map((sk) => (
              <option key={sk.id} value={sk.id}>
                {sk.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="py-12 flex flex-col items-center justify-center gap-3">
          <div className="w-8 h-8 border-3 border-primary-container border-t-transparent rounded-full animate-spin" />
          <span className="text-[14px] text-on-surface-variant font-medium">
            {t('loading')}
          </span>
        </div>
      ) : !insights ? (
        <div className="py-8 text-center text-on-surface-variant text-[14px]">
          {t('dashboard_no_data')}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Summary Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-surface-container border border-outline-variant rounded-xl p-4 flex flex-col justify-between">
              <span className="text-[13px] font-bold text-on-surface-variant uppercase tracking-wider">
                {t('dashboard_total_sessions')}
              </span>
              <span className="text-[28px] font-extrabold text-on-surface mt-1">
                {insights.totals.sessions}
              </span>
            </div>

            <div className="bg-surface-container border border-outline-variant rounded-xl p-4 flex flex-col justify-between">
              <span className="text-[13px] font-bold text-on-surface-variant uppercase tracking-wider">
                {t('dashboard_completion_rate')}
              </span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-[28px] font-extrabold text-on-surface">
                  {completionRate}%
                </span>
                <span className="text-[13px] text-on-surface-variant font-medium">
                  ({insights.totals.completed}/{insights.totals.sessions})
                </span>
              </div>
            </div>

            <div className="bg-surface-container border border-outline-variant rounded-xl p-4 flex flex-col justify-between">
              <span className="text-[13px] font-bold text-on-surface-variant uppercase tracking-wider">
                {t('dashboard_median_duration')}
              </span>
              <span
                className="text-[28px] font-extrabold text-on-surface mt-1"
                title={insights.totals.median_duration_s === null ? t('dashboard_no_data') : undefined}
              >
                {insights.totals.median_duration_s !== null
                  ? t('app.dashboard_seconds', { value: insights.totals.median_duration_s })
                  : '—'}
              </span>
            </div>
          </div>

          {/* Steps Breakdown Table */}
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-left border-collapse min-w-[620px]">
              <thead>
                <tr className="border-b border-outline-variant/80 text-[12px] font-bold text-on-surface-variant uppercase tracking-wider">
                  <th className="py-3 px-3 w-[70px]">{t('dashboard_step')}</th>
                  <th className="py-3 px-3">{t('dashboard_instruction')}</th>
                  <th className="py-3 px-3 w-[160px]">{t('dashboard_mistake_rate')}</th>
                  <th className="py-3 px-3 w-[110px]">{t('dashboard_median_duration')}</th>
                  <th className="py-3 px-3 w-[100px] text-right">{t('dashboard_safety_stops')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/40">
                {insights.steps.map((step) => {
                  const isStruggle = maxMistakeStep === step.n;
                  const mistakePercent =
                    step.mistake_rate !== null ? Math.round(step.mistake_rate * 100) : null;

                  return (
                    <tr
                      key={step.n}
                      className={`hover:bg-surface-container/30 transition-colors ${
                        isStruggle ? 'bg-error/5' : ''
                      }`}
                    >
                      {/* Step Number */}
                      <td className="py-3.5 px-3 font-bold text-[15px] text-on-surface">
                        #{step.n}
                      </td>

                      {/* Instruction & Struggle Badge */}
                      <td className="py-3.5 px-3">
                        <div className="flex flex-col gap-1">
                          <span className="text-[14px] text-on-surface font-medium">
                            {step.instruction}
                          </span>
                          {isStruggle && (
                            <span className="inline-flex items-center gap-1 w-fit text-[11px] font-bold px-2 py-0.5 rounded-full bg-error/15 text-error border border-error/30">
                              <span className="material-symbols-outlined text-[13px]">
                                warning
                              </span>
                              {t('dashboard_struggle_step')}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Mistake Rate Heat Bar */}
                      <td className="py-3.5 px-3">
                        {step.mistake_rate === null ? (
                          <span
                            className="text-on-surface-variant font-mono text-[14px]"
                            title={t('dashboard_no_data')}
                          >
                            —
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-surface-container-high rounded-full h-2.5 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  step.mistake_rate > 0.4
                                    ? 'bg-error'
                                    : step.mistake_rate > 0.15
                                    ? 'bg-amber-400'
                                    : 'bg-emerald-500'
                                }`}
                                style={{ width: `${Math.min(100, mistakePercent || 0)}%` }}
                              />
                            </div>
                            <span className="text-[13px] font-mono font-bold text-on-surface w-[40px] text-right">
                              {mistakePercent}%
                            </span>
                          </div>
                        )}
                      </td>

                      {/* Median Duration */}
                      <td className="py-3.5 px-3 text-[14px] font-mono font-semibold text-on-surface">
                        {step.median_secs === null ? (
                          <span className="text-on-surface-variant" title={t('dashboard_no_data')}>
                            —
                          </span>
                        ) : (
                          t('app.dashboard_seconds', { value: step.median_secs })
                        )}
                      </td>

                      {/* Safety Stops */}
                      <td className="py-3.5 px-3 text-right">
                        {step.safety_stops === null ? (
                          <span className="text-on-surface-variant font-mono" title={t('dashboard_no_data')}>
                            —
                          </span>
                        ) : step.safety_stops > 0 ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-bold text-[12px] bg-error/15 text-error border border-error/30 font-mono">
                            <span className="material-symbols-outlined text-[13px]">
                              shield_with_heart
                            </span>
                            {step.safety_stops}
                          </span>
                        ) : (
                          <span className="text-on-surface-variant font-mono text-[13px]">0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
};
