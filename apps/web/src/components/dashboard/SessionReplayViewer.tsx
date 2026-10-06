import React, { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { SessionReplayResponse, SessionReplayEvent } from '../../lib/api';

interface SessionReplayViewerProps {
  replay: SessionReplayResponse | null;
  loading: boolean;
  onClose?: () => void;
}

export const SessionReplayViewer: React.FC<SessionReplayViewerProps> = ({
  replay,
  loading,
  onClose,
}) => {
  const { t } = useTranslation();
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  if (loading) {
    return (
      <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm">
        <div className="py-12 flex flex-col items-center justify-center gap-3">
          <div className="w-8 h-8 border-3 border-primary-container border-t-transparent rounded-full animate-spin" />
          <span className="text-[14px] text-on-surface-variant font-medium">
            {t('loading')}
          </span>
        </div>
      </section>
    );
  }

  if (!replay) {
    return (
      <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-6 shadow-sm text-center">
        <span className="material-symbols-outlined text-[36px] text-on-surface-variant mb-2 block opacity-40">
          history
        </span>
        <h3 className="text-[16px] font-bold text-on-surface mb-1">
          {t('dashboard_session_replay')}
        </h3>
        <p className="text-[14px] text-on-surface-variant max-w-sm mx-auto">
          {t('dashboard_select_session')}
        </p>
      </section>
    );
  }

  const { session, events } = replay;
  const startMs = new Date(session.started_at).getTime();

  const formatOffset = (eventIso: string) => {
    const evMs = new Date(eventIso).getTime();
    const diffSec = Math.max(0, Math.floor((evMs - startMs) / 1000));
    const m = Math.floor(diffSec / 60);
    const s = diffSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const getEventBadge = (event: SessionReplayEvent) => {
    switch (event.type) {
      case 'step_done':
        return {
          icon: 'check_circle',
          label: 'Step Done',
          color: 'bg-success/15 text-success border-success/30',
        };
      case 'mistake':
        return {
          icon: 'cancel',
          label: 'Mistake',
          color: 'bg-amber-400/15 text-amber-500 border-amber-400/30',
        };
      case 'safety_stop':
        return {
          icon: 'shield_with_heart',
          label: 'Safety Stop',
          color: 'bg-error/15 text-error border-error/30 font-bold',
        };
      case 'blocked':
        return {
          icon: 'visibility_off',
          label: 'Blocked',
          color: 'bg-surface-container-high text-on-surface-variant border-outline-variant',
        };
      case 'ask_why':
        return {
          icon: 'help_outline',
          label: 'Ask Why',
          color: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
        };
      case 'point':
        return {
          icon: 'touch_app',
          label: 'Point At',
          color: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
        };
      case 'verify':
        return {
          icon: 'fact_check',
          label: 'Verify Step',
          color: 'bg-teal-500/15 text-teal-400 border-teal-500/30',
        };
      case 'coach_line':
        return {
          icon: 'smart_toy',
          label: 'Coach Line',
          color: 'bg-primary-container/20 text-primary-container border-primary-container/30',
        };
      case 'trainee_line':
        return {
          icon: 'person',
          label: 'Trainee Line',
          color: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
        };
      default:
        return {
          icon: 'info',
          label: event.type,
          color: 'bg-surface-container-high text-on-surface-variant border-outline-variant',
        };
    }
  };

  return (
    <section className="bg-surface-container-low border border-outline-variant rounded-2xl p-4 sm:p-5 shadow-sm space-y-5">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-outline-variant">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[17px] font-bold text-on-surface">
              {session.first_name}
            </span>
            <span
              className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${
                session.status === 'completed'
                  ? 'bg-success/15 text-success border-success/30'
                  : session.status === 'live'
                  ? 'bg-error/15 text-error border-error/30'
                  : 'bg-surface-container-high text-on-surface-variant border-outline-variant'
              }`}
            >
              {session.status}
            </span>
            <span className="text-[11px] font-semibold uppercase px-2 py-0.5 rounded-md bg-surface-container text-on-surface border border-outline-variant">
              {session.language}
            </span>
          </div>
          <span className="text-[13px] text-on-surface-variant font-mono">
            {new Date(session.started_at).toLocaleString()} • ID: {session.id}
          </span>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface border border-outline-variant cursor-pointer self-start sm:self-auto"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        )}
      </div>

      {/* Events Timeline */}
      <div className="space-y-3">
        <h4 className="text-[13px] font-bold text-on-surface-variant uppercase tracking-wider">
          Timeline Events ({events.length})
        </h4>

        {events.length === 0 ? (
          <div className="py-6 text-center text-on-surface-variant text-[14px]">
            No events recorded for this session.
          </div>
        ) : (
          <div className="relative pl-6 space-y-4 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-outline-variant/60">
            {events.map((ev, idx) => {
              const badge = getEventBadge(ev);
              const offset = formatOffset(ev.t);
              const isSpeechLine = ev.type === 'coach_line' || ev.type === 'trainee_line';

              return (
                <div key={idx} className="relative group">
                  {/* Timeline dot */}
                  <span className="absolute -left-[19px] top-1.5 w-3 h-3 rounded-full bg-surface-container-highest border-2 border-primary-container" />

                  <div className="bg-surface-container border border-outline-variant rounded-xl p-3 sm:p-3.5 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-mono font-bold text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-md">
                          {offset}
                        </span>

                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border ${badge.color}`}
                        >
                          <span className="material-symbols-outlined text-[14px]">
                            {badge.icon}
                          </span>
                          {badge.label}
                        </span>

                        {ev.step && (
                          <span className="text-[11px] font-medium text-on-surface-variant">
                            Step #{ev.step}
                          </span>
                        )}
                      </div>

                      {ev.latency_ms !== undefined && ev.latency_ms > 0 && (
                        <span className="text-[11px] font-mono text-on-surface-variant">
                          {ev.latency_ms}ms
                        </span>
                      )}
                    </div>

                    {/* Speech or Reason text */}
                    {isSpeechLine ? (
                      <div
                        className={`p-2.5 rounded-lg text-[14px] leading-relaxed ${
                          ev.type === 'coach_line'
                            ? 'bg-primary-container/10 border-l-2 border-primary-container text-on-surface'
                            : 'bg-indigo-500/10 border-l-2 border-indigo-400 text-on-surface'
                        }`}
                      >
                        <span className="text-[11px] font-bold uppercase block text-on-surface-variant mb-0.5">
                          {ev.type === 'coach_line' ? 'Coach' : 'Trainee'}
                        </span>
                        {ev.reason}
                      </div>
                    ) : (
                      ev.reason && (
                        <p className="text-[14px] text-on-surface font-medium leading-normal">
                          {ev.reason}
                        </p>
                      )
                    )}

                    {/* Frame image if attached */}
                    {ev.frame_uri && (
                      <div className="pt-1">
                        <button
                          type="button"
                          onClick={() => setPreviewImage(ev.frame_uri || null)}
                          className="relative group/img inline-block rounded-lg overflow-hidden border border-outline-variant hover:border-primary-container transition-all cursor-pointer"
                        >
                          <img
                            src={ev.frame_uri}
                            alt="Event snapshot frame"
                            className="w-40 h-28 object-cover"
                            loading="lazy"
                          />
                          <span className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 flex items-center justify-center text-white text-[12px] font-medium transition-opacity">
                            <span className="material-symbols-outlined text-[18px] mr-1">
                              zoom_in
                            </span>
                            View
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Image Modal Preview */}
      {previewImage && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewImage(null)}
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm cursor-pointer"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-surface-container border border-outline-variant rounded-2xl max-w-2xl w-full overflow-hidden shadow-2xl"
          >
            <div className="flex items-center justify-between p-3.5 border-b border-outline-variant">
              <span className="text-[14px] font-bold text-on-surface">
                {t('dashboard_frame_preview')}
              </span>
              <button
                type="button"
                onClick={() => setPreviewImage(null)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high text-on-surface cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            <div className="p-2 bg-black flex items-center justify-center">
              <img
                src={previewImage}
                alt="Full preview"
                className="max-h-[70vh] w-auto object-contain rounded"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
