import React, { useEffect, useState } from 'react';
import { collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useTranslation } from '../../i18n';
import type { Session } from '../../../../../shared/schema/ts/sessions';
import type { InsightSkill } from '../../lib/api';

interface LiveNowStripProps {
  skillsMap: Record<string, InsightSkill>;
  onSelectSession?: (sessionId: string) => void;
}

export const LiveNowStrip: React.FC<LiveNowStripProps> = ({
  skillsMap,
  onSelectSession,
}) => {
  const { t } = useTranslation();
  const [liveSessions, setLiveSessions] = useState<Session[]>([]);
  const [now, setNow] = useState(Date.now());

  // Update timer every second for elapsed duration display
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const q = query(
      collection(db, 'sessions'),
      where('status', '==', 'live'),
      orderBy('started_at', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const currentTime = Date.now();
        const cutoff12m = currentTime - 12 * 60 * 1000;
        const sessions = snapshot.docs
          .map((doc) => ({ id: doc.id, ...doc.data() } as Session))
          .filter((s) => {
            if (s.trainee_uid === 'smoke-trainee') return false;
            const started = new Date(s.started_at).getTime();
            // 12-minute filter: treat older live sessions as abandoned
            return started >= cutoff12m;
          });
        setLiveSessions(sessions);
      },
      (err) => {
        console.warn('Live sessions snapshot error:', err);
      }
    );

    return () => unsubscribe();
  }, []);

  const formatElapsed = (startedAt: string) => {
    const startMs = new Date(startedAt).getTime();
    const diffSec = Math.max(0, Math.floor((now - startMs) / 1000));
    const m = Math.floor(diffSec / 60);
    const s = diffSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 sm:p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-error opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-error" />
          </span>
          <h2 className="text-[17px] font-bold text-on-surface">
            {t('dashboard_live_now')}
          </h2>
          <span className="text-[12px] font-bold px-2 py-0.5 rounded-full bg-error/15 text-error border border-error/30 tracking-wider">
            {t('dashboard_live_badge')} ({liveSessions.length})
          </span>
        </div>
      </div>

      {liveSessions.length === 0 ? (
        <div className="py-6 text-center text-on-surface-variant font-medium text-[15px] bg-surface-container/50 rounded-xl border border-dashed border-outline-variant/60">
          <span className="material-symbols-outlined text-[28px] mb-1 block opacity-50">
            person_off
          </span>
          {t('dashboard_no_live')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {liveSessions.map((session) => {
            // Operators are shown by a short anonymous id, never by name
            const firstName = session.trainee_uid
              ? t('app.dashboard_trainee_short_id', { id: session.trainee_uid.slice(-4) })
              : t('dashboard_trainee');
            const skill = skillsMap[session.skill_id];
            const skillTitle = skill?.title || session.skill_id;
            const currentStep = session.current_step || 1;
            const totalSteps = session.steps?.length || 4;
            const elapsed = formatElapsed(session.started_at);

            return (
              <div
                key={session.id}
                onClick={() => onSelectSession?.(session.id)}
                className="bg-surface-container hover:bg-surface-container-high border border-outline-variant rounded-xl p-3.5 flex flex-col justify-between transition-all cursor-pointer shadow-sm active:scale-[0.99]"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <span className="text-[15px] font-bold text-on-surface block truncate">
                      {firstName}
                    </span>
                    <span className="text-[13px] text-on-surface-variant block truncate">
                      {skillTitle}
                    </span>
                  </div>
                  <span className="text-[11px] font-semibold uppercase px-2 py-0.5 rounded-md bg-surface-container-high text-on-surface border border-outline-variant shrink-0">
                    {session.language}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-1 text-[13px] font-medium pt-2 border-t border-outline-variant/60">
                  <span className="text-primary-container font-semibold flex items-center gap-1">
                    <span className="material-symbols-outlined text-[16px]">play_circle</span>
                    {t('dashboard_step_n_of_m', { n: currentStep, total: totalSteps })}
                  </span>
                  <span className="text-on-surface-variant flex items-center gap-1 font-mono">
                    <span className="material-symbols-outlined text-[15px]">timer</span>
                    {elapsed}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
