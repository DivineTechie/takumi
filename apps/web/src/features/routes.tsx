/* eslint-disable react-refresh/only-export-components */
// Standard Work Studio routes: record a task, follow the Studio run, review and publish, library.
import type { ReactNode } from 'react';
import type { Role } from '../lib/auth';
import { CaptureScreen } from './capture/CaptureScreen';
import { AgentTrace } from './review/AgentTrace';
import { MasterReview } from './review/MasterReview';
import { SkillLibrary } from './library/SkillLibrary';

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
