import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  analyzeTranscript,
  matchProjectByName,
  warmupModel,
} from './soloRoutingService';
import { Project } from './projectService';
import { Transcript } from '@/types';

const mockInvoke = vi.mocked(invoke);

const mkProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'id-1',
  name: 'Tandem',
  path: 'D:/Dev-projects/Tandem',
  aliases: [],
  auto_discovered: false,
  ...overrides,
});

const mkTranscript = (text: string, audio_start_time = 0): Transcript => ({
  text,
  timestamp: '00:00',
  audio_start_time,
} as Transcript);

const baseDecision = {
  project_switch: { detected: false, project_name: null, confidence: 0 },
  intents: [],
  notes: [],
  stop_detected: false,
  revoke_last: false,
};

describe('matchProjectByName', () => {
  const projects: Project[] = [
    mkProject({ id: '1', name: 'Tandem', aliases: ['the meeting app'] }),
    mkProject({ id: '2', name: 'Jos', aliases: ['joss', 'jos project'] }),
    mkProject({ id: '3', name: 'Website', aliases: [] }),
  ];

  it('returns null for null input', () => {
    expect(matchProjectByName(null, projects)).toBeNull();
  });

  it('matches exact name case-insensitively', () => {
    expect(matchProjectByName('tandem', projects)?.id).toBe('1');
    expect(matchProjectByName('TANDEM', projects)?.id).toBe('1');
  });

  it('matches by alias when no name match', () => {
    expect(matchProjectByName('the meeting app', projects)?.id).toBe('1');
    expect(matchProjectByName('joss', projects)?.id).toBe('2');
  });

  it('falls back to substring match for STT garbles (registered is contained)', () => {
    // Whisper heard "Josproject" — "jos" is substring of "josproject"
    expect(matchProjectByName('Josproject', projects)?.id).toBe('2');
  });

  it('falls back to substring match (input is contained in registered)', () => {
    expect(matchProjectByName('tande', projects)?.id).toBe('1');
  });

  it('returns null when no match', () => {
    expect(matchProjectByName('CompletelyUnknown', projects)).toBeNull();
  });
});

describe('analyzeTranscript', () => {
  const projects = [mkProject()];
  const activeProject = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when transcripts empty', async () => {
    const result = await analyzeTranscript([], projects, activeProject, 'model');
    expect(result).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('invokes ollama_chat_json with camelCase parameter keys (Tauri 2.x)', async () => {
    mockInvoke.mockResolvedValueOnce(JSON.stringify(baseDecision));
    await analyzeTranscript(
      [mkTranscript('hello')],
      projects,
      activeProject,
      'gemma4:26b',
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [command, args] = mockInvoke.mock.calls[0];
    expect(command).toBe('ollama_chat_json');
    // Tauri 2 renames snake_case Rust params → camelCase JS keys
    expect(args).toHaveProperty('systemPrompt');
    expect(args).toHaveProperty('userPrompt');
    expect(args).not.toHaveProperty('system_prompt');
    expect(args).not.toHaveProperty('user_prompt');
    expect(args).toMatchObject({ model: 'gemma4:26b', endpoint: null });
  });

  it('drops project_switch below 0.55 confidence', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        ...baseDecision,
        project_switch: { detected: true, project_name: 'Tandem', confidence: 0.4 },
      }),
    );
    const result = await analyzeTranscript(
      [mkTranscript('x')],
      projects,
      activeProject,
      'm',
    );
    expect(result?.project_switch.detected).toBe(false);
  });

  it('keeps project_switch at 0.55 confidence (inclusive threshold)', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        ...baseDecision,
        project_switch: { detected: true, project_name: 'Tandem', confidence: 0.55 },
      }),
    );
    const result = await analyzeTranscript(
      [mkTranscript('x')],
      projects,
      activeProject,
      'm',
    );
    expect(result?.project_switch.detected).toBe(true);
  });

  it('filters intents below 0.7 confidence', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        ...baseDecision,
        intents: [
          { description: 'keep', confidence: 0.8 },
          { description: 'drop', confidence: 0.6 },
          { description: 'edge', confidence: 0.7 },
        ],
      }),
    );
    const result = await analyzeTranscript(
      [mkTranscript('x')],
      projects,
      activeProject,
      'm',
    );
    expect(result?.intents.map(i => i.description).sort()).toEqual(['edge', 'keep']);
  });

  it('filters notes below 0.7 confidence', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        ...baseDecision,
        notes: [
          { description: 'keep', confidence: 0.9 },
          { description: 'drop', confidence: 0.5 },
        ],
      }),
    );
    const result = await analyzeTranscript(
      [mkTranscript('x')],
      projects,
      activeProject,
      'm',
    );
    expect(result?.notes.map(n => n.description)).toEqual(['keep']);
  });

  it('defaults revoke_last to false when field is missing from model response', async () => {
    const decisionWithoutRevoke = { ...baseDecision };
    delete (decisionWithoutRevoke as Partial<typeof baseDecision>).revoke_last;
    mockInvoke.mockResolvedValueOnce(JSON.stringify(decisionWithoutRevoke));
    const result = await analyzeTranscript(
      [mkTranscript('x')],
      projects,
      activeProject,
      'm',
    );
    expect(result?.revoke_last).toBe(false);
  });

  it('preserves revoke_last=true when Gemma detects a retraction', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({ ...baseDecision, revoke_last: true }),
    );
    const result = await analyzeTranscript(
      [mkTranscript('ignore that')],
      projects,
      activeProject,
      'm',
    );
    expect(result?.revoke_last).toBe(true);
  });

  it('returns null when invoke rejects (Ollama down)', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('timeout'));
    const result = await analyzeTranscript(
      [mkTranscript('x')],
      projects,
      activeProject,
      'm',
    );
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON from the model', async () => {
    mockInvoke.mockResolvedValueOnce('not json {{{');
    const result = await analyzeTranscript(
      [mkTranscript('x')],
      projects,
      activeProject,
      'm',
    );
    expect(result).toBeNull();
  });

  it('tolerates missing arrays in the response (intents, notes)', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        project_switch: baseDecision.project_switch,
        stop_detected: false,
      }),
    );
    const result = await analyzeTranscript(
      [mkTranscript('x')],
      projects,
      activeProject,
      'm',
    );
    expect(result?.intents).toEqual([]);
    expect(result?.notes).toEqual([]);
  });
});

describe('warmupModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes ollama_chat_json with camelCase keys and a trivial payload', async () => {
    mockInvoke.mockResolvedValueOnce('{"ready":true}');
    await warmupModel('gemma4:26b');
    expect(mockInvoke).toHaveBeenCalledWith(
      'ollama_chat_json',
      expect.objectContaining({
        model: 'gemma4:26b',
        systemPrompt: expect.any(String),
        userPrompt: expect.any(String),
        endpoint: null,
      }),
    );
  });

  it('swallows errors (fire-and-forget)', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('ollama not running'));
    await expect(warmupModel('m')).resolves.toBeUndefined();
  });

  it('passes endpoint through when provided', async () => {
    mockInvoke.mockResolvedValueOnce('{}');
    await warmupModel('m', 'http://remote:11434');
    expect(mockInvoke).toHaveBeenCalledWith(
      'ollama_chat_json',
      expect.objectContaining({ endpoint: 'http://remote:11434' }),
    );
  });
});
