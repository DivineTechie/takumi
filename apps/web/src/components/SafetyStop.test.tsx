import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SafetyStop } from './SafetyStop';
import { I18nProvider } from '../i18n';

describe('SafetyStop component', () => {
  it('renders alertdialog with provided safety rule and action button', () => {
    const onMadeSafe = vi.fn();
    render(
      <I18nProvider initialLanguage="en">
        <SafetyStop
          rule="No bare copper visible outside a terminal"
          onMadeSafe={onMadeSafe}
        />
      </I18nProvider>
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('aria-live')).toBe('assertive');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    expect(screen.getByText('STOP')).toBeDefined();
    expect(screen.getByText('No bare copper visible outside a terminal')).toBeDefined();
    expect(screen.getByText('Keep your hands away.')).toBeDefined();

    const button = screen.getByRole('button', { name: "I've made it safe" });
    expect(button).toBeDefined();
    fireEvent.click(button);
    expect(onMadeSafe).toHaveBeenCalledTimes(1);
  });

  it('renders "Unsafe condition" when rule is null', () => {
    render(
      <I18nProvider initialLanguage="en">
        <SafetyStop rule={null} onMadeSafe={vi.fn()} />
      </I18nProvider>
    );

    expect(screen.getByText('STOP')).toBeDefined();
    expect(screen.getByText('Unsafe condition')).toBeDefined();
  });

  it('moves focus to the action button on mount and restores on unmount', () => {
    // Create an input outside to hold initial focus
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    const { unmount } = render(
      <I18nProvider initialLanguage="en">
        <SafetyStop rule="Disconnect power" onMadeSafe={vi.fn()} />
      </I18nProvider>
    );

    const button = screen.getByRole('button', { name: "I've made it safe" });
    expect(document.activeElement).toBe(button);

    unmount();
    expect(document.activeElement).toBe(input);
    document.body.removeChild(input);
  });
});
