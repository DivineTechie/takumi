import { useState, useEffect } from 'react';
import { CaptureScreen } from './features/capture/CaptureScreen';
import { AgentTrace } from './features/review/AgentTrace';
import { MasterReview } from './features/review/MasterReview';
import { SkillLibrary } from './features/library/SkillLibrary';

export default function App() {
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  };

  if (currentPath === '/capture' || currentPath === '/') {
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

  return <CaptureScreen onJobCreated={(jobId) => navigate(`/forge/${jobId}`)} />;
}
