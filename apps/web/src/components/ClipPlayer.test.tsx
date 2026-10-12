import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClipPlayer } from './ClipPlayer';

describe('ClipPlayer', () => {
  it('renders master demonstration badge and localized subtitles >= 20px', () => {
    const onClose = vi.fn();
    render(
      <ClipPlayer
        url="https://example.com/master.mp4"
        start_s={10}
        end_s={20}
        kind="master_clip"
        why="फेरूल तारों को बिखरने से रोकता है।"
        translated={true}
        onClose={onClose}
      />
    );

    expect(screen.getByText("Master's own demonstration")).toBeInTheDocument();
    const subtitle = screen.getByText('फेरूल तारों को बिखरने से रोकता है।');
    expect(subtitle).toBeInTheDocument();
    expect(subtitle).toHaveClass('text-[20px]');
    expect(subtitle).toHaveClass('font-bold');
  });

  it('renders mistake clip badge with red outline', () => {
    const onClose = vi.fn();
    render(
      <ClipPlayer
        url="https://example.com/mistake.mp4"
        start_s={5}
        end_s={12}
        kind="mistake_clip"
        label="AI-generated example of the wrong way"
        onClose={onClose}
      />
    );

    const badge = screen.getByText('AI-generated example of the wrong way');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('border-red-500');
  });

  it('displays "translated" badge when translated is false', () => {
    const onClose = vi.fn();
    render(
      <ClipPlayer
        url="https://example.com/master.mp4"
        start_s={0}
        end_s={5}
        kind="master_clip"
        why="Bootlace ferrule keeps wires intact."
        translated={false}
        onClose={onClose}
      />
    );

    expect(screen.getByText('translated')).toBeInTheDocument();
  });

  it('provides accessible 44px close button that invokes onClose', () => {
    const onClose = vi.fn();
    render(
      <ClipPlayer
        url="https://example.com/master.mp4"
        start_s={0}
        end_s={10}
        kind="master_clip"
        onClose={onClose}
      />
    );

    const closeBtn = screen.getByRole('button', { name: /close clip/i });
    expect(closeBtn).toBeInTheDocument();
    expect(closeBtn).toHaveClass('min-w-[44px]');
    expect(closeBtn).toHaveClass('min-h-[44px]');

    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
