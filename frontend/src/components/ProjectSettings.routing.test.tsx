import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * The routing toggle is the user-visible half of "do not run the LLM". These cover the contract that
 * matters: the switch reflects and writes the stored preference, and the model picker goes inert when
 * the LLM is off rather than sitting there implying it still does something.
 */

const setRoutingModel = vi.fn();
const setRoutingEnabled = vi.fn();
const soloMode = { routingModel: 'gemma4:12b', setRoutingModel, routingEnabled: true, setRoutingEnabled };

vi.mock('@/contexts/SoloModeContext', () => ({
  useSoloMode: () => soloMode,
  SOLO_HUD_ENABLED_KEY: 'tandem-solo-hud-enabled',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/services/projectService', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  importScannedProjects: vi.fn(),
  scanDirectory: vi.fn(),
  pickDirectory: vi.fn(),
}));

import { ProjectSettings } from './ProjectSettings';

const toggle = () => screen.getByRole('switch', { name: /automatic routing/i });

describe('routing toggle', () => {
  beforeEach(() => {
    soloMode.routingEnabled = true;
    setRoutingEnabled.mockClear();
    setRoutingModel.mockClear();
  });
  afterEach(cleanup);

  it('shows automatic routing on, with the model picker usable', () => {
    render(<ProjectSettings />);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Routing model')).toBeEnabled();
  });

  it('turns routing off when the switch is clicked', () => {
    render(<ProjectSettings />);
    fireEvent.click(toggle());
    expect(setRoutingEnabled).toHaveBeenCalledWith(false);
  });

  it('disables the model picker while routing is off', () => {
    soloMode.routingEnabled = false;
    render(<ProjectSettings />);
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Routing model')).toBeDisabled();
  });

  it('says the spoken switch still works without a model', () => {
    soloMode.routingEnabled = false;
    render(<ProjectSettings />);
    expect(screen.getByText(/still works/i)).toBeInTheDocument();
  });

  it('turns routing back on from the off state', () => {
    soloMode.routingEnabled = false;
    render(<ProjectSettings />);
    fireEvent.click(toggle());
    expect(setRoutingEnabled).toHaveBeenCalledWith(true);
  });

  it('still lets the model be changed while routing is on', () => {
    render(<ProjectSettings />);
    fireEvent.change(screen.getByLabelText('Routing model'), { target: { value: 'gemma4:12b' } });
    expect(setRoutingModel).toHaveBeenCalledWith('gemma4:12b');
  });
});
