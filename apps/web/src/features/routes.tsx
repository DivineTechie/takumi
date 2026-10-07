// Owned by Member B: register /capture, /review/:skillId, /library and /forge/:jobId here.
import type { ReactNode } from 'react';
import type { Role } from '../lib/auth';
import { CaptureScreen, CaptureScreenProps } from './capture/CaptureScreen';
import { AgentTrace } from './review/AgentTrace';
import { MasterReview } from './review/MasterReview';
import { SkillLibrary } from './library/SkillLibrary';

export { CaptureScreen, AgentTrace, MasterReview, SkillLibrary };
export type { CaptureScreenProps };

export interface FeatureRoute {
  path: string;
  roles: Role[];
  element: ReactNode;
}

export const featureRoutes: FeatureRoute[] = [
  { path: '/capture', roles: ['master'], element: <CaptureScreen /> },
  { path: '/forge/:jobId', roles: ['master', 'supervisor'], element: <AgentTrace /> },
  { path: '/review/:skillId', roles: ['master', 'supervisor'], element: <MasterReview /> },
  { path: '/library', roles: ['master', 'supervisor'], element: <SkillLibrary /> },
];
