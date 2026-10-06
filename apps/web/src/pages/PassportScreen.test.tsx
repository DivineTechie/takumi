import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PassportScreen } from './PassportScreen';
import * as apiModule from '../lib/api';
import type { PublicPassport } from '../lib/api';

// Mock API
vi.mock('../lib/api', () => ({
  fetchPublicPassport: vi.fn(),
}));

// Mock qrcode
vi.mock('qrcode', () => ({
  default: {
    toString: vi.fn().mockResolvedValue('<svg data-testid="mock-qr-svg"></svg>'),
  },
}));

describe('PassportScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWithRoute = (initialPath = '/passport/pass-123') => {
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/passport/:id" element={<PassportScreen />} />
          <Route path="/" element={<div>Home Screen</div>} />
        </Routes>
      </MemoryRouter>
    );
  };

  it('renders loading state initially', () => {
    vi.mocked(apiModule.fetchPublicPassport).mockImplementation(
      () => new Promise(() => {}) // never resolves
    );

    renderWithRoute();
    expect(screen.getByText('Verifying Skill Passport...')).toBeInTheDocument();
  });

  it('renders 404 not found state when API rejects with 404', async () => {
    vi.mocked(apiModule.fetchPublicPassport).mockRejectedValue({
      status: 404,
      message: 'Certificate not found',
    });

    renderWithRoute('/passport/invalid-id');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /This certificate could not be found/i })
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/The requested passport ID may be invalid or does not exist/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Return to TAKUMI/i })).toHaveAttribute('href', '/');
  });

  it('renders verified certificate details with CSS Hanko seal when badge_url is null', async () => {
    const mockPassport: PublicPassport = {
      id: 'pp_mock_123',
      display_first_name: 'Tushar',
      skill_title: 'Precision Wire Soldering',
      master_display_name: 'Master Kenji',
      language: 'en',
      issued_at: '2026-10-06T12:00:00Z',
      sessions_count: 3,
      verified: true,
      badge_url: null,
    };

    vi.mocked(apiModule.fetchPublicPassport).mockResolvedValue(mockPassport);

    renderWithRoute('/passport/pp_mock_123');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Tushar' })).toBeInTheDocument();
    });

    expect(screen.getByText('TAKUMI SKILL PASSPORT')).toBeInTheDocument();
    expect(screen.getByText('Verified by TAKUMI')).toBeInTheDocument();
    expect(screen.getByText('Precision Wire Soldering')).toBeInTheDocument();
    expect(screen.getByText('Master Kenji')).toBeInTheDocument();
    expect(screen.getByText(/3 Clean Runs Verified/i)).toBeInTheDocument();
    expect(screen.getByText(/Badge art generated with Gemini \(SynthID\)/i)).toBeInTheDocument();

    // Verify Fallback CSS Hanko Seal
    expect(screen.getByLabelText('Traditional Hanko Seal')).toBeInTheDocument();
    expect(screen.getByText('匠')).toBeInTheDocument();

    // Verify QR code rendered
    await waitFor(() => {
      expect(screen.getByLabelText('Scan QR Code to verify passport')).toBeInTheDocument();
    });
  });

  it('renders image badge when badge_url is present', async () => {
    const mockPassport: PublicPassport = {
      id: 'pp_mock_456',
      display_first_name: 'तुषार',
      skill_title: 'Hydraulic Valve Inspection',
      master_display_name: 'Master Sarah',
      language: 'hi',
      issued_at: '2026-10-06T14:30:00Z',
      sessions_count: 4,
      verified: true,
      badge_url: 'https://storage.googleapis.com/test-bucket/badges/test.png',
    };

    vi.mocked(apiModule.fetchPublicPassport).mockResolvedValue(mockPassport);

    renderWithRoute('/passport/pp_mock_456');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'तुषार' })).toBeInTheDocument();
    });

    const badgeImg = screen.getByRole('img', { name: 'Skill Seal Badge' });
    expect(badgeImg).toBeInTheDocument();
    expect(badgeImg).toHaveAttribute('src', mockPassport.badge_url);
    expect(screen.queryByLabelText('Traditional Hanko Seal')).not.toBeInTheDocument();
  });

  it('calls window.print when Download PDF is clicked', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    const mockPassport: PublicPassport = {
      id: 'pp_mock_print',
      display_first_name: 'Nguyễn',
      skill_title: 'Robotic Arm Calibration',
      master_display_name: 'Master Lin',
      language: 'vi',
      issued_at: '2026-10-06T10:00:00Z',
      sessions_count: 3,
      verified: true,
      badge_url: null,
    };

    vi.mocked(apiModule.fetchPublicPassport).mockResolvedValue(mockPassport);

    renderWithRoute('/passport/pp_mock_print');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Nguyễn' })).toBeInTheDocument();
    });

    const printBtn = screen.getByRole('button', { name: /Download PDF/i });
    fireEvent.click(printBtn);
    expect(printSpy).toHaveBeenCalledTimes(1);

    printSpy.mockRestore();
  });

  it('copies URL when Share button is clicked', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const mockPassport: PublicPassport = {
      id: 'pp_mock_share',
      display_first_name: "D'Souza",
      skill_title: 'Sensor Alignment',
      master_display_name: 'Master Alan',
      language: 'en',
      issued_at: '2026-10-06T09:00:00Z',
      sessions_count: 3,
      verified: true,
      badge_url: null,
    };

    vi.mocked(apiModule.fetchPublicPassport).mockResolvedValue(mockPassport);

    renderWithRoute('/passport/pp_mock_share');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: "D'Souza" })).toBeInTheDocument();
    });

    const shareBtn = screen.getByRole('button', { name: /Share/i });
    fireEvent.click(shareBtn);
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument();
    });
  });
});
