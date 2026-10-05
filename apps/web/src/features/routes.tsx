// Owned by Member B: register /capture, /review/:skillId, /library and /forge/:jobId here.
import type { ReactNode } from 'react';
import type { Role } from '../lib/auth';

export interface FeatureRoute {
  path: string;
  roles: Role[];
  element: ReactNode;
}

export const featureRoutes: FeatureRoute[] = [];
