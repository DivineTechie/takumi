import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SetupForm } from './components/SetupForm';

describe('SetupForm Component', () => {
  it('renders with default skill title and Japanese language selected', () => {
    const handleStart = vi.fn();
    render(<SetupForm onStart={handleStart} isStarting={false} />);

    expect(screen.getByText('Record Master Task')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Wire a DIN-rail terminal block')).toBeInTheDocument();
    expect(screen.getByText('日本語')).toBeInTheDocument();
  });

  it('allows changing the source language', () => {
    const handleStart = vi.fn();
    render(<SetupForm onStart={handleStart} isStarting={false} />);

    const hindiBtn = screen.getByText('हिन्दी');
    fireEvent.click(hindiBtn);

    const startBtn = screen.getByText('START CAPTURE');
    fireEvent.click(startBtn);

    expect(handleStart).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: 'hi',
        skillTitle: 'Wire a DIN-rail terminal block',
      })
    );
  });

  it('validates an empty task title', () => {
    const handleStart = vi.fn();
    render(<SetupForm onStart={handleStart} isStarting={false} />);

    const input = screen.getByLabelText('Task title');
    fireEvent.change(input, { target: { value: '   ' } });

    const startBtn = screen.getByText('START CAPTURE');
    fireEvent.click(startBtn);

    expect(screen.getByText('Enter a task title to start recording')).toBeInTheDocument();
    expect(handleStart).not.toHaveBeenCalled();
  });
});
