/**
 * Member B Feature Routes.
 * Exports all Member B screens and route definitions for mounting in Member A's App.tsx.
 */

import React from 'react';
import { CaptureScreen, CaptureScreenProps } from './capture/CaptureScreen';
import { AgentTrace } from './review/AgentTrace';
import { MasterReview } from './review/MasterReview';
import { SkillLibrary } from './library/SkillLibrary';

export { CaptureScreen, AgentTrace, MasterReview, SkillLibrary };
export type { CaptureScreenProps };

export interface MemberBRoutesProps {
  currentPath: string;
  navigate: (path: string) => void;
}

/**
 * Convenience router component for Member B screens.
 * Can be mounted directly inside Member A's App.tsx.
 */
export const MemberBRoutes: React.FC<MemberBRoutesProps> = ({ currentPath, navigate }) => {
  if (currentPath === '/capture') {
    return <CaptureScreen onJobCreated={(jobId) => navigate(`/forge/${jobId}`)} />;
  }

  if (currentPath.startsWith('/forge/')) {
    const jobId = currentPath.replace('/forge/', '');
    return (
      <AgentTrace
        jobId={jobId}
        onNavigateToReview={(skillId) => navigate(`/review/${skillId}`)}
      />
    );
  }

  if (currentPath.startsWith('/review/')) {
    const skillId = currentPath.replace('/review/', '');
    return (
      <MasterReview
        skillId={skillId}
        onPublished={() => navigate('/library')}
      />
    );
  }

  if (currentPath === '/library') {
    return (
      <SkillLibrary
        onNavigateToCapture={() => navigate('/capture')}
        onNavigateToReview={(skillId) => navigate(`/review/${skillId}`)}
      />
    );
  }

  return null;
};
