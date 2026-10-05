/* eslint-disable react-refresh/only-export-components */
import React, { lazy, Suspense } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { RoleGuard } from './components/RoleGuard';
import { featureRoutes, type FeatureRoute } from './features/routes';

const SignInScreen = lazy(() => import('./pages/SignInScreen'));
const SignInFinishScreen = lazy(() => import('./pages/SignInFinishScreen'));
const HomeScreen = lazy(() => import('./pages/HomeScreen'));
const ChooseLessonScreen = lazy(() => import('./pages/ChooseLessonScreen'));
const CoachBeforeStartScreen = lazy(() => import('./pages/CoachBeforeStartScreen'));
const PassportScreen = lazy(() => import('./pages/PassportScreen'));
const DashboardScreen = lazy(() => import('./pages/DashboardScreen'));
const EvalsScreen = lazy(() => import('./pages/EvalsScreen'));
const NotFoundScreen = lazy(() => import('./pages/NotFoundScreen'));

export const LoadingFallback: React.FC = () => (
  <div className="min-h-screen bg-surface flex items-center justify-center p-4">
    <div className="flex flex-col items-center gap-4">
      <div className="w-10 h-10 border-4 border-primary-container border-t-transparent rounded-full animate-spin" />
      <span className="text-on-surface-variant font-medium">Loading...</span>
    </div>
  </div>
);

export function buildRouteObjects(extraFeatures: FeatureRoute[] = featureRoutes): RouteObject[] {
  return [
    // Public routes
    {
      path: '/signin',
      element: (
        <Suspense fallback={<LoadingFallback />}>
          <SignInScreen />
        </Suspense>
      ),
    },
    {
      path: '/signin/finish',
      element: (
        <Suspense fallback={<LoadingFallback />}>
          <SignInFinishScreen />
        </Suspense>
      ),
    },
    {
      path: '/passport/:id',
      element: (
        <Suspense fallback={<LoadingFallback />}>
          <PassportScreen />
        </Suspense>
      ),
    },

    // Authenticated Home
    {
      path: '/',
      element: (
        <RoleGuard>
          <Suspense fallback={<LoadingFallback />}>
            <HomeScreen />
          </Suspense>
        </RoleGuard>
      ),
    },

    // Trainee or supervisor
    {
      path: '/coach',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor']}>
          <Suspense fallback={<LoadingFallback />}>
            <ChooseLessonScreen />
          </Suspense>
        </RoleGuard>
      ),
    },
    {
      path: '/coach/:skillId',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor']}>
          <Suspense fallback={<LoadingFallback />}>
            <CoachBeforeStartScreen />
          </Suspense>
        </RoleGuard>
      ),
    },

    // Supervisor only
    {
      path: '/dashboard',
      element: (
        <RoleGuard allowedRoles={['supervisor']}>
          <Suspense fallback={<LoadingFallback />}>
            <DashboardScreen />
          </Suspense>
        </RoleGuard>
      ),
    },

    // Any authenticated user
    {
      path: '/evals',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor', 'master']}>
          <Suspense fallback={<LoadingFallback />}>
            <EvalsScreen />
          </Suspense>
        </RoleGuard>
      ),
    },

    // Member B screens dynamically mounted behind RoleGuard
    ...extraFeatures.map((feat) => ({
      path: feat.path,
      element: (
        <RoleGuard allowedRoles={feat.roles}>
          <Suspense fallback={<LoadingFallback />}>
            {feat.element}
          </Suspense>
        </RoleGuard>
      ),
    })),

    // 404 fallback
    {
      path: '*',
      element: (
        <Suspense fallback={<LoadingFallback />}>
          <NotFoundScreen />
        </Suspense>
      ),
    },
  ];
}

export function createAppRouter(extraFeatures: FeatureRoute[] = featureRoutes) {
  return createBrowserRouter(buildRouteObjects(extraFeatures));
}
