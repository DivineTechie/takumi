import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GalleryScreen } from './GalleryScreen';
import * as apiModule from '../lib/api';

vi.mock('../lib/api', () => ({
  fetchGallery: vi.fn(),
  inspectGallery: vi.fn(),
}));

const mockItems: apiModule.GalleryItem[] = [
  {
    id: 'gal_3f9a1c2b7d4e',
    category: 'candle',
    image_url: 'https://storage.googleapis.com/test-bucket/gallery/9c1e0a7b44d2.jpg',
  },
  {
    id: 'gal_a81d55e0c9f3',
    category: 'candle',
    image_url: 'https://storage.googleapis.com/test-bucket/gallery/0b7f3e9a12c6.jpg',
  },
];

describe('GalleryScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.fetchGallery).mockResolvedValue(mockItems);
  });

  it('renders benchmark gallery heading, category pills, and concealed ground truth cards', async () => {
    render(
      <MemoryRouter>
        <GalleryScreen />
      </MemoryRouter>
    );

    expect(await screen.findByText("Judges' Benchmark Gallery")).toBeInTheDocument();
    expect(screen.getByText('Candle')).toBeInTheDocument();
    expect(screen.getByText('PCB 1')).toBeInTheDocument();

    // Verify tiles render with concealed labels
    const concealedBadges = await screen.findAllByText(/Ground truth concealed until inspected/i);
    expect(concealedBadges.length).toBe(2);
    // No id is shown before inspection; alt text is neutral
    expect(screen.queryByText('gal_3f9a1c2b7d4e')).not.toBeInTheDocument();
    expect(screen.queryByText('gal_a81d55e0c9f3')).not.toBeInTheDocument();
    expect(screen.getAllByAltText('VisA candle test part').length).toBe(2);
  });

  it('inspects a tile and reveals ground truth alongside hit evaluation', async () => {
    vi.mocked(apiModule.inspectGallery).mockResolvedValue({
      inspection_id: 'insp-gal-1',
      unit_id: null,
      product_id: 'candle',
      ai_verdict: 'ok',
      defective: false,
      defect: null,
      confidence: 0.95,
      where: null,
      mode: 'few_false_alarms',
      stages: [
        { stage: 'screen', model: 'gemini-3.5-flash-lite', defective: false, defect: null, confidence: 0.95, where: null, ms: 320 },
      ],
      total_ms: 320,
      checks_run: 1,
      created_at: new Date().toISOString(),
      inspector_uid: 'tester-1',
      source: 'PUBLIC DATA: VisA (CC BY 4.0)',
      dataset_label: 'normal',
    });

    render(
      <MemoryRouter>
        <GalleryScreen />
      </MemoryRouter>
    );

    await screen.findByText("Judges' Benchmark Gallery");
    const inspectButtons = await screen.findAllByRole('button', { name: /Inspect Unit/i });
    expect(inspectButtons.length).toBe(2);

    fireEvent.click(inspectButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/HIT — Clean unit verified/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Dataset Label:/i)).toBeInTheDocument();
    expect(screen.getByText('normal')).toBeInTheDocument();
    expect(screen.getByText(/320 ms/i)).toBeInTheDocument();
  });

  it('switches category when clicking category tab', async () => {
    render(
      <MemoryRouter>
        <GalleryScreen />
      </MemoryRouter>
    );

    await screen.findByText("Judges' Benchmark Gallery");
    expect(apiModule.fetchGallery).toHaveBeenCalledWith('candle');

    const pcbTab = screen.getByRole('button', { name: /PCB 1/i });
    fireEvent.click(pcbTab);

    await waitFor(() => {
      expect(apiModule.fetchGallery).toHaveBeenCalledWith('pcb1');
    });
  });
});
