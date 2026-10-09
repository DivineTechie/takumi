import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InspectScreen } from './InspectScreen';
import * as apiModule from '../lib/api';

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { uid: 'sup-1', email: 'supervisor@takumi.test' },
    role: 'supervisor',
  }),
}));

vi.mock('../lib/api', () => ({
  fetchProducts: vi.fn(),
  inspectUnit: vi.fn(),
  submitInspectionDecision: vi.fn(),
}));

vi.mock('../lib/imageResize', () => ({
  resizeImageForUpload: vi.fn().mockResolvedValue({
    base64: 'data:image/jpeg;base64,mockedbase64data',
    width: 1024,
    height: 768,
  }),
}));

const mockProducts: apiModule.ProductItem[] = [
  {
    id: 'pcb1',
    name: 'Printed Circuit Board (PCB-1)',
    description: '4-layer FR4 industrial control board',
    defect_types: ['scratch', 'missing_component', 'bridging'],
    default_mode: 'few_false_alarms',
    reference_images: ['ref1.jpg', 'ref2.jpg', 'ref3.jpg'],
  },
];

describe('InspectScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.fetchProducts).mockResolvedValue(mockProducts);
  });

  it('renders station title, product select, serial input, and upload controls', async () => {
    render(
      <MemoryRouter>
        <InspectScreen />
      </MemoryRouter>
    );

    expect(await screen.findByText('Quality Inspection Station')).toBeInTheDocument();
    expect(screen.getByLabelText(/Target Product/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e\.g\. SN-2026-A0948/i)).toBeInTheDocument();
    expect(screen.getByText('Take Photo (Camera)')).toBeInTheDocument();
    expect(screen.getByText('Upload Image File')).toBeInTheDocument();
  });

  it('validates serial input before submission', async () => {
    render(
      <MemoryRouter>
        <InspectScreen />
      </MemoryRouter>
    );

    await screen.findByText('Quality Inspection Station');
    const input = screen.getByPlaceholderText(/e\.g\. SN-2026-A0948/i);

    // Enter invalid characters and blur
    fireEvent.change(input, { target: { value: 'invalid serial with spaces & $' } });
    fireEvent.blur(input);
    expect(screen.getByText(/Alphanumeric, dot, dash, underscore only/i)).toBeInTheDocument();
  });

  it('submits inspection and displays OK verdict with latency breakdown', async () => {
    vi.mocked(apiModule.inspectUnit).mockResolvedValue({
      inspection_id: 'insp-123',
      unit_id: 'UNIT-99',
      product_id: 'pcb1',
      ai_verdict: 'ok',
      defective: false,
      defect: null,
      confidence: 0.96,
      where: null,
      mode: 'few_false_alarms',
      stages: [
        { stage: 'screen', defective: false, defect: null, confidence: 0.96, where: null, ms: 450 },
      ],
      total_ms: 450,
      checks_run: 1,
      created_at: new Date().toISOString(),
      inspector_uid: 'sup-1',
      source: 'live',
      human_decision: null,
    });

    render(
      <MemoryRouter>
        <InspectScreen />
      </MemoryRouter>
    );

    await screen.findByText('Quality Inspection Station');
    const input = screen.getByPlaceholderText(/e\.g\. SN-2026-A0948/i);
    fireEvent.change(input, { target: { value: 'UNIT-99' } });

    // Simulate file input
    const fileInput = document.querySelector('input[type="file"]:not([capture])') as HTMLInputElement;
    const file = new File(['dummy content'], 'test.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Wait for file to load into preview
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Inspect Unit/i })).not.toBeDisabled();
    });

    // Click Inspect Unit
    const inspectBtn = screen.getByRole('button', { name: /Inspect Unit/i });
    fireEvent.click(inspectBtn);

    // Expect verdict
    await waitFor(() => {
      expect(screen.getByText('VERIFIED OK')).toBeInTheDocument();
    });

    expect(screen.getByText(/Total API/i)).toBeInTheDocument();
    expect(screen.getAllByText(/450 ms/i).length).toBeGreaterThan(0);
    expect(apiModule.inspectUnit).toHaveBeenCalledWith(expect.objectContaining({
      unit_id: 'UNIT-99',
      product_id: 'pcb1',
      mode: 'few_false_alarms',
    }));
  });

  it('displays DEFECT verdict and allows supervisor to record disposition', async () => {
    vi.mocked(apiModule.inspectUnit).mockResolvedValue({
      inspection_id: 'insp-456',
      unit_id: 'UNIT-DEFECT-01',
      product_id: 'pcb1',
      ai_verdict: 'defective',
      defective: true,
      defect: 'scratch',
      confidence: 0.92,
      where: 'upper right corner',
      mode: 'few_false_alarms',
      stages: [
        { stage: 'screen', defective: true, defect: 'scratch', confidence: 0.9, where: 'upper right corner', ms: 380 },
        { stage: 'confirm', defective: true, defect: 'scratch', confidence: 0.94, where: 'upper right corner', ms: 510 },
      ],
      total_ms: 890,
      checks_run: 2,
      created_at: new Date().toISOString(),
      inspector_uid: 'sup-1',
      source: 'live',
      human_decision: null,
    });

    vi.mocked(apiModule.submitInspectionDecision).mockResolvedValue({
      id: 'insp-456',
      human_decision: 'confirmed_defect',
      decision_at: new Date().toISOString(),
      decision_by: 'sup-1',
    });

    render(
      <MemoryRouter>
        <InspectScreen />
      </MemoryRouter>
    );

    await screen.findByText('Quality Inspection Station');
    const input = screen.getByPlaceholderText(/e\.g\. SN-2026-A0948/i);
    fireEvent.change(input, { target: { value: 'UNIT-DEFECT-01' } });

    const fileInput = document.querySelector('input[type="file"]:not([capture])') as HTMLInputElement;
    const file = new File(['dummy'], 'test.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Inspect Unit/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /Inspect Unit/i }));

    await waitFor(() => {
      expect(screen.getByText('DEFECT FLAGGED')).toBeInTheDocument();
      expect(screen.getByText('scratch')).toBeInTheDocument();
      expect(screen.getByText('upper right corner')).toBeInTheDocument();
    });

    // Supervisor decision buttons
    const confirmDefectBtn = screen.getByRole('button', { name: /Confirm Defect/i });
    expect(confirmDefectBtn).toBeInTheDocument();
    fireEvent.click(confirmDefectBtn);

    await waitFor(() => {
      expect(apiModule.submitInspectionDecision).toHaveBeenCalledWith('insp-456', 'confirmed_defect');
    });
  });
});
