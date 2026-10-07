import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import {
  Sparkles,
  Plus,
  Search,
  CheckCircle2,
  Clock,
  Layers,
  Globe,
  ArrowRight,
} from 'lucide-react';
import type { Skill } from '../../../../../shared/schema/ts/skills.ts';

export interface SkillLibraryProps {
  onNavigateToCapture?: () => void;
  onNavigateToReview?: (skillId: string) => void;
}

export const SkillLibrary: React.FC<SkillLibraryProps> = ({
  onNavigateToCapture,
  onNavigateToReview,
}) => {
  const navigate = useNavigate();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'in_review'>('all');

  useEffect(() => {
    try {
      const skillsRef = collection(db, 'skills');
      const q = query(skillsRef, orderBy('created_at', 'desc'));
      const unsub = onSnapshot(q, (snapshot) => {
        const loaded: Skill[] = [];
        snapshot.forEach((d) => loaded.push(d.data() as Skill));
        if (loaded.length > 0) {
          setSkills(loaded);
        } else {
          // Fallback seed
          import('../../../../../shared/seed/skill_terminal_wiring_v1.json').then((seed) => {
            setSkills([seed.default as unknown as Skill]);
          });
        }
      });
      return () => unsub();
    } catch {
      import('../../../../../shared/seed/skill_terminal_wiring_v1.json').then((seed) => {
        setSkills([seed.default as unknown as Skill]);
      });
    }
  }, []);

  const filteredSkills = skills.filter((s) => {
    const matchesSearch =
      s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.master.display_name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || s.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#09090b',
        color: '#f4f4f5',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '2rem',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: '1080px', margin: '0 auto' }}>
        {/* Top Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #27272a',
            paddingBottom: '1.5rem',
            marginBottom: '2rem',
          }}
        >
          <div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                color: '#fbbf24',
                fontSize: '0.85rem',
                fontWeight: 700,
                marginBottom: '0.35rem',
              }}
            >
              <Sparkles size={16} />
              <span>TAKUMI 匠 · Skill Library</span>
            </div>
            <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: 0, color: '#ffffff' }}>
              Master Craftsman Skills
            </h1>
          </div>

          <button
            onClick={() => {
              if (onNavigateToCapture) onNavigateToCapture();
              else navigate('/capture');
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              backgroundColor: '#f59e0b',
              color: '#000000',
              border: 'none',
              borderRadius: '0.75rem',
              padding: '0.75rem 1.25rem',
              fontSize: '0.95rem',
              fontWeight: 800,
              cursor: 'pointer',
              boxShadow: '0 4px 15px rgba(245, 158, 11, 0.3)',
            }}
          >
            <Plus size={18} />
            <span>RECORD NEW CAPTURE</span>
          </button>
        </header>

        {/* Search & Filter Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            marginBottom: '1.5rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              backgroundColor: '#18181b',
              border: '1px solid #27272a',
              borderRadius: '0.5rem',
              padding: '0.6rem 1rem',
              flex: 1,
              maxWidth: '400px',
            }}
          >
            <Search size={18} color="#71717a" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by skill title or craftsman..."
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                color: '#ffffff',
                fontSize: '0.9rem',
                outline: 'none',
                width: '100%',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {(['all', 'published', 'in_review'] as const).map((filter) => (
              <button
                key={filter}
                onClick={() => setStatusFilter(filter)}
                style={{
                  backgroundColor: statusFilter === filter ? '#f59e0b' : '#18181b',
                  color: statusFilter === filter ? '#000000' : '#a1a1aa',
                  border: statusFilter === filter ? 'none' : '1px solid #27272a',
                  borderRadius: '0.5rem',
                  padding: '0.5rem 1rem',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {filter === 'all' ? 'All Skills' : filter.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>

        {/* Grid of Skill Cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '1.25rem',
          }}
        >
          {filteredSkills.map((item) => {
            const isPublished = item.status === 'published';

            return (
              <div
                key={item.id}
                onClick={() => {
                  if (onNavigateToReview) onNavigateToReview(item.id);
                  else navigate(`/review/${item.id}`);
                }}
                style={{
                  backgroundColor: '#18181b',
                  border: '1px solid #27272a',
                  borderRadius: '1rem',
                  padding: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  cursor: 'pointer',
                  transition: 'border-color 0.2s, transform 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      backgroundColor: isPublished ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                      color: isPublished ? '#34d399' : '#fbbf24',
                      border: isPublished ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(245, 158, 11, 0.3)',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '0.2rem 0.5rem',
                      borderRadius: '0.35rem',
                      textTransform: 'uppercase',
                    }}
                  >
                    {isPublished ? <CheckCircle2 size={12} /> : <Clock size={12} />}
                    <span>{item.status.replace('_', ' ')}</span>
                  </span>

                  <span style={{ color: '#71717a', fontSize: '0.75rem' }}>
                    {item.created_at ? new Date(item.created_at).toLocaleDateString() : 'Recent'}
                  </span>
                </div>

                <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#ffffff', lineHeight: 1.3 }}>
                  {item.title}
                </div>

                <div style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>
                  Master: <strong style={{ color: '#d4d4d8' }}>{item.master.display_name}</strong>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', color: '#a1a1aa', fontSize: '0.8rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <Layers size={14} color="#fbbf24" />
                    <span>{item.steps.length} Steps</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <Globe size={14} color="#34d399" />
                    <span>{item.languages.length} Languages</span>
                  </div>
                </div>

                <div
                  style={{
                    marginTop: '0.5rem',
                    paddingTop: '0.75rem',
                    borderTop: '1px solid #27272a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    color: '#fbbf24',
                    fontSize: '0.85rem',
                    fontWeight: 700,
                  }}
                >
                  <span>{isPublished ? 'Open Review / Coach' : 'Review & Publish'}</span>
                  <ArrowRight size={16} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
