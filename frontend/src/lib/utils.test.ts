import { describe, it, expect } from 'vitest';
import { cn, isOllamaNotInstalledError } from './utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('deduplicates tailwind classes', () => {
    expect(cn('p-4', 'p-2')).toBe('p-2');
  });

  it('handles empty input', () => {
    expect(cn()).toBe('');
  });
});

describe('isOllamaNotInstalledError', () => {
  it('returns false for empty string', () => {
    expect(isOllamaNotInstalledError('')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isOllamaNotInstalledError(null as unknown as string)).toBe(false);
    expect(isOllamaNotInstalledError(undefined as unknown as string)).toBe(false);
  });

  it('detects "connection refused"', () => {
    expect(isOllamaNotInstalledError('Error: connection refused')).toBe(true);
  });

  it('detects "cannot connect"', () => {
    expect(isOllamaNotInstalledError('Cannot connect to Ollama server')).toBe(true);
  });

  it('detects "cli not found"', () => {
    expect(isOllamaNotInstalledError('Ollama CLI not found')).toBe(true);
  });

  it('detects "econnrefused"', () => {
    expect(isOllamaNotInstalledError('ECONNREFUSED 127.0.0.1:11434')).toBe(true);
  });

  it('detects "not in path"', () => {
    expect(isOllamaNotInstalledError('ollama not in PATH')).toBe(true);
  });

  it('detects "please check if the server is running"', () => {
    expect(isOllamaNotInstalledError('Please check if the server is running')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isOllamaNotInstalledError('Model not found: llama2')).toBe(false);
    expect(isOllamaNotInstalledError('Internal server error')).toBe(false);
  });
});
