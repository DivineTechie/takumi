/* eslint-disable react-refresh/only-export-components */
import React, { lazy, Suspense } from 'react';
import { createBrowserRouter, Outlet, type RouteObject } from 'react-router-dom';
import { RoleGuard } from './components/RoleGuard';
import { featureRoutes, type FeatureRoute } from './features/routes';
import { VersionBanner } from './components/VersionBanner';

const SignInScreen = lazy(() => import('./pages/SignInScreen'));
const SignInFinishScreen = lazy(() => import('./pages/SignInFinishScreen'));
const HomeScreen = lazy(() => import('./pages/HomeScreen'));
const ChooseLessonScreen = lazy(() => import('./pages/ChooseLessonScreen'));
const CoachBeforeStartScreen = lazy(() => import('./pages/CoachBeforeStartScreen'));
const PassportScreen = lazy(() => import('./pages/PassportScreen'));
const StatusScreen = lazy(() => import('./pages/StatusScreen'));
const DashboardScreen = lazy(() => import('./pages/DashboardScreen'));
const EvalsScreen = lazy(() => import('./pages/EvalsScreen'));
const InspectScreen = lazy(() => import('./pages/InspectScreen'));
const GalleryScreen = lazy(() => import('./pages/GalleryScreen'));
const VirtualMachineScreen = lazy(() => import('./pages/VirtualMachineScreen'));
const MachineWatchScreen = lazy(() => import('./pages/MachineWatchScreen'));
const UnitScreen = lazy(() => import('./pages/UnitScreen'));
const ControlTowerScreen = lazy(() => import('./pages/ControlTowerScreen'));
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
    {
      element: (
        <>
          <VersionBanner />
          <Outlet />
        </>
      ),
      children: [
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
    {
      path: '/status',
      element: (
        <Suspense fallback={<LoadingFallback />}>
          <StatusScreen />
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

    // Trainee, supervisor, or master (lesson preview)
    {
      path: '/coach',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor', 'master']}>
          <Suspense fallback={<LoadingFallback />}>
            <ChooseLessonScreen />
          </Suspense>
        </RoleGuard>
      ),
    },
    {
      path: '/coach/:skillId',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor', 'master']}>
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
      // Public: the evidence page needs no sign-in (aggregates only)
      path: '/evals',
      element: (
        <Suspense fallback={<LoadingFallback />}>
          <EvalsScreen />
        </Suspense>
      ),
    },

    // Quality Inspection (Pillar 2)
    {
      path: '/inspect',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor', 'master']}>
          <Suspense fallback={<LoadingFallback />}>
            <InspectScreen />
          </Suspense>
        </RoleGuard>
      ),
    },
    {
      path: '/inspect/gallery',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor', 'master']}>
          <Suspense fallback={<LoadingFallback />}>
            <GalleryScreen />
          </Suspense>
        </RoleGuard>
      ),
    },

    // Machine Watch (Pillar 3)
    {
      path: '/machines/virtual',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor', 'master']}>
          <Suspense fallback={<LoadingFallback />}>
            <VirtualMachineScreen />
          </Suspense>
        </RoleGuard>
      ),
    },
    {
      path: '/control',
      element: (
        <RoleGuard allowedRoles={['supervisor']}>
          <Suspense fallback={<LoadingFallback />}>
            <ControlTowerScreen />
          </Suspense>
        </RoleGuard>
      ),
    },
    {
      path: '/units/:unitId',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor', 'master']}>
          <Suspense fallback={<LoadingFallback />}>
            <UnitScreen />
          </Suspense>
        </RoleGuard>
      ),
    },
    {
      path: '/machines/watch',
      element: (
        <RoleGuard allowedRoles={['trainee', 'supervisor', 'master']}>
          <Suspense fallback={<LoadingFallback />}>
            <MachineWatchScreen />
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
      ],
    },
  ];
}

export function createAppRouter(extraFeatures: FeatureRoute[] = featureRoutes) {
  return createBrowserRouter(buildRouteObjects(extraFeatures));
}
