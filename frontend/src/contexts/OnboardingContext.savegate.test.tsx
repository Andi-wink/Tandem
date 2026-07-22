import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * Regression test for the mount-time save race in OnboardingProvider.
 *
 * On a cold start, OnboardingProvider state defaults to completed:false and the debounced
 * auto-save effect schedules saveOnboardingStatus() ~1s after mount. Meanwhile
 * loadOnboardingStatus() awaits several slow Rust invokes (parakeet_init,
 * parakeet_has_available_models, builtin_ai_get_available_summary_model) that can take
 * longer than the debounce. Before the fix, the debounced save fired FIRST and persisted
 * completed:false over a store that said completed:true, re-showing onboarding to a user who
 * had already finished it.
 *
 * The fix gates the auto-save behind initialLoadDoneRef, which is only set once the initial
 * load attempt has resolved. This test forces the load to resolve AFTER the debounce window
 * and asserts save_onboarding_status_cmd is never invoked with completed:false. Against the
 * unfixed code this fails: exactly one save with completed:false fires inside the debounce
 * window before the load resolves.
 */

const mockInvoke = vi.mocked(invoke);

const SAVED_STATUS = {
  version: '1.0',
  completed: true,
  current_step: 4,
  model_status: { parakeet: 'downloaded', summary: 'downloaded' },
  last_updated: '2026-01-01T00:00:00.000Z',
};

// invoke implementation: get_onboarding_status resolves after `loadDelayMs` (timer-based, so
// fake timers control exactly when it resolves); everything else resolves immediately.
function makeInvoke(loadDelayMs: number) {
  return (cmd: string): Promise<unknown> => {
    switch (cmd) {
      case 'get_onboarding_status':
        return new Promise((resolve) => setTimeout(() => resolve(SAVED_STATUS), loadDelayMs));
      case 'parakeet_init':
        return Promise.resolve(undefined);
      case 'parakeet_has_available_models':
        return Promise.resolve(true);
      case 'builtin_ai_get_available_summary_model':
        return Promise.resolve('gemma3:1b');
      case 'check_first_launch':
        return Promise.resolve(false);
      case 'builtin_ai_get_recommended_model':
        return Promise.resolve('gemma3:1b');
      case 'parakeet_get_available_models':
        return Promise.resolve([]);
      case 'save_onboarding_status_cmd':
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  };
}

function savesWithCompletedFalse() {
  return mockInvoke.mock.calls.filter(
    (c) =>
      c[0] === 'save_onboarding_status_cmd' &&
      (c[1] as { status?: { completed?: boolean } } | undefined)?.status?.completed === false
  );
}

function allSaveCalls() {
  return mockInvoke.mock.calls.filter((c) => c[0] === 'save_onboarding_status_cmd');
}

// Imported after mocks are declared (vi.mock in test/setup.ts is hoisted).
import { OnboardingProvider } from './OnboardingContext';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OnboardingProvider mount-time save gate', () => {
  it('never persists completed:false before a slow get_onboarding_status load resolves', async () => {
    // Load resolves at 3000ms, well past the 1000ms auto-save debounce.
    mockInvoke.mockImplementation(makeInvoke(3000) as unknown as typeof invoke);

    render(
      <OnboardingProvider>
        <div>child</div>
      </OnboardingProvider>
    );

    // Advance past the debounce window (1000ms) but before the load resolves (3000ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    // The core regression assertion: no save at all should have fired yet, and definitely none
    // carrying completed:false. Unfixed code fires exactly one save with completed:false here.
    expect(savesWithCompletedFalse()).toHaveLength(0);
    expect(allSaveCalls()).toHaveLength(0);

    // Now let the load resolve (applies completed:true).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // After the load, completed:true keeps the existing completed-guard from ever saving
    // defaults. No completed:false save must have occurred at any point.
    expect(savesWithCompletedFalse()).toHaveLength(0);
  });
});
