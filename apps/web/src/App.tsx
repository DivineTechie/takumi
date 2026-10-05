import { useState, useEffect } from 'react';
import { CaptureScreen } from './features/capture/CaptureScreen';

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
      <main
        style={{
          minHeight: '100vh',
          backgroundColor: '#09090b',
          color: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '2rem', marginBottom: '1rem', color: '#fbbf24' }}>
          TAKUMI 匠 · Agent Trace
        </h1>
        <p style={{ color: '#a1a1aa', maxWidth: '400px', marginBottom: '2rem' }}>
          Job ID: <code style={{ color: '#ffffff' }}>{jobId}</code>
        </p>
        <button
          onClick={() => navigate('/capture')}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#27272a',
            border: '1px solid #3f3f46',
            color: '#ffffff',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Return to Capture
        </button>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        backgroundColor: '#09090b',
        color: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        fontFamily: 'system-ui, sans-serif',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '2rem', marginBottom: '1rem' }}>TAKUMI 匠</h1>
      <button
        onClick={() => navigate('/capture')}
        style={{
          padding: '0.85rem 1.75rem',
          backgroundColor: '#f59e0b',
          color: '#000000',
          border: 'none',
          borderRadius: '0.75rem',
          fontSize: '1rem',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        Launch Master Capture (/capture)
      </button>
    </main>
  );
}
