import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewProductForm } from './NewProductForm';
import * as apiModule from '../../lib/api';
import * as resizeModule from '../../lib/imageResize';

vi.mock('../../lib/api', () => ({
  createProductWithImages: vi.fn(),
  ApiError: class extends Error {},
}));
vi.mock('../../lib/imageResize', () => ({ resizeImageForUpload: vi.fn() }));

const product: apiModule.ProductItem = {
  id: 'charger_kit_ab12',
  name: 'Charger kit',
  description: 'adapter with cable coiled',
  defect_types: ['label on cable', 'cable loose'],
  reference_image_paths: [],
  default_mode: 'few_false_alarms',
  source: 'LIVE',
  created_at: '2026-10-11T00:00:00Z',
};

describe('NewProductForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resizeModule.resizeImageForUpload).mockResolvedValue({ base64: 'QUJD', dataUrl: 'data:image/jpeg;base64,QUJD' } as never);
    vi.mocked(apiModule.createProductWithImages).mockResolvedValue(product);
  });

  it('needs 3 photos before saving', async () => {
    render(<NewProductForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Charger kit/), { target: { value: 'Charger kit' } });
    fireEvent.click(screen.getByText('Save product'));
    expect(await screen.findByRole('alert')).toHaveTextContent('3 photos');
    expect(apiModule.createProductWithImages).not.toHaveBeenCalled();
  });

  it('sends name, defects and three resized photos', async () => {
    const onCreated = vi.fn();
    render(<NewProductForm onCreated={onCreated} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Charger kit/), { target: { value: 'Charger kit' } });
    fireEvent.change(screen.getByPlaceholderText(/coiled and banded/), { target: { value: 'adapter with cable coiled' } });
    fireEvent.change(screen.getByPlaceholderText(/label on the cable/), { target: { value: 'label on cable, cable loose,' } });
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    for (const i of [1, 2, 3]) fireEvent.change(screen.getByLabelText(`Photo ${i}`), { target: { files: [file] } });
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3));
    fireEvent.click(screen.getByText('Save product'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(product));
    expect(apiModule.createProductWithImages).toHaveBeenCalledWith({
      name: 'Charger kit',
      description: 'adapter with cable coiled',
      defect_types: ['label on cable', 'cable loose'],
      images_b64: ['QUJD', 'QUJD', 'QUJD'],
    });
  });
});
