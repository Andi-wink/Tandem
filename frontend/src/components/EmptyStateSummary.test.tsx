import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyStateSummary } from './EmptyStateSummary';

describe('EmptyStateSummary handover option', () => {
  it('offers the handover document alongside the summary', () => {
    render(<EmptyStateSummary onGenerate={() => {}} hasModel onGenerateHandover={() => {}} />);
    expect(screen.getByRole('button', { name: /create handover document/i })).toBeInTheDocument();
  });

  it('fires the handover callback on click', () => {
    const onGenerateHandover = vi.fn();
    render(<EmptyStateSummary onGenerate={() => {}} hasModel onGenerateHandover={onGenerateHandover} />);
    fireEvent.click(screen.getByRole('button', { name: /create handover document/i }));
    expect(onGenerateHandover).toHaveBeenCalledTimes(1);
  });

  it('stays available when no model is configured, since it needs none', () => {
    render(<EmptyStateSummary onGenerate={() => {}} hasModel={false} onGenerateHandover={() => {}} />);
    expect(screen.getByRole('button', { name: /generate summary/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /create handover document/i })).toBeEnabled();
  });

  it('disables itself while building so a double click cannot write twice', () => {
    render(
      <EmptyStateSummary onGenerate={() => {}} hasModel onGenerateHandover={() => {}} isGeneratingHandover />,
    );
    expect(screen.getByRole('button', { name: /building handover document/i })).toBeDisabled();
  });

  it('shows nothing extra when the caller does not supply the handover action', () => {
    render(<EmptyStateSummary onGenerate={() => {}} hasModel />);
    expect(screen.queryByRole('button', { name: /handover/i })).toBeNull();
  });
});
