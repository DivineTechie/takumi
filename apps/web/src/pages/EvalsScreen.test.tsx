import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EvalsScreen } from './EvalsScreen';
import * as apiModule from '../lib/api';
import visa from '../evals/visaResults.json';

vi.mock('../lib/api', () => ({ fetchLiveLatency: vi.fn() }));

describe('EvalsScreen', () => {
  it('shows labelled inspection results, the unscored soak test and live timings', async () => {
    vi.mocked(apiModule.fetchLiveLatency).mockResolvedValue({
      label: 'LIVE',
      days: 30,
      endpoints: [{ endpoint: 'watch', n: 625, p50_ms: 1194, p90_ms: 2006, model_p50_ms: 1000, first_ts: null, last_ts: null }],
    });
    render(
      <MemoryRouter>
        <EvalsScreen />
      </MemoryRouter>
    );
    expect(screen.getByText(visa.label)).toBeInTheDocument();
    expect(screen.getByText('HOME RIG')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    const expected = `${(visa.setups.few_false_alarms.defects_caught * 100).toFixed(1)}%`;
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    expect(screen.getByText(/61\/61/)).toBeInTheDocument();
    expect(await screen.findByText('Station Watch step watcher (Flash-Lite)')).toBeInTheDocument();
    expect(screen.getByText('1.2 s')).toBeInTheDocument();
  });
});
