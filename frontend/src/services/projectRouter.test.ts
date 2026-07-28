import { describe, it, expect } from 'vitest';
import { parseFileUnderCommand, heuristicProjectRoute } from './projectRouter';
import { Project } from './projectService';

const mkProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'id-1',
  name: 'Tandem',
  path: 'D:/Dev-projects/Tandem',
  aliases: [],
  auto_discovered: false,
  session_id: null,
  created_at: '',
  ...overrides,
} as Project);

const projects: Project[] = [
  mkProject({ id: '1', name: 'Tandem', aliases: ['the meeting app'] }),
  mkProject({ id: '2', name: 'Jos', aliases: ['joss', 'jos project'] }),
  mkProject({ id: '3', name: 'Hirepath_IQ', aliases: ['hirepath'] }),
  mkProject({ id: '4', name: 'Acme', aliases: [] }),
];

describe('parseFileUnderCommand', () => {
  it('captures the name for "file this under Acme"', () => {
    expect(parseFileUnderCommand('file this under Acme')).toBe('Acme');
  });

  it('rejects "move this to the Jos project" — a leading article after a weak preposition signals a document-location phrase, not a project', () => {
    // "to/into/in" are overloaded; a leading article ("the …") means ordinary chat, so the grammar
    // deliberately returns null. Say "file this under the Jos project" (below) to file by name.
    expect(parseFileUnderCommand('move this to the Jos project')).toBeNull();
  });

  it('captures for "move this to Acme Corp" (weak preposition, no article, short tail)', () => {
    expect(parseFileUnderCommand('move this to Acme Corp')).toBe('Acme Corp');
  });

  it('captures for "file this under the Jos project" (under strips the article)', () => {
    expect(parseFileUnderCommand('file this under the Jos project')).toBe('Jos project');
  });

  it('captures for "put it in Tandem"', () => {
    expect(parseFileUnderCommand('put it in Tandem')).toBe('Tandem');
  });

  it('captures for "route everything to hirepath"', () => {
    expect(parseFileUnderCommand('route everything to hirepath')).toBe('hirepath');
  });

  it('tolerates a trailing period', () => {
    expect(parseFileUnderCommand('file this under Acme.')).toBe('Acme');
  });

  it('does NOT match an ordinary "can you file a bug report"', () => {
    expect(parseFileUnderCommand('can you file a bug report')).toBeNull();
  });

  it('does NOT match "move the box to the left"', () => {
    expect(parseFileUnderCommand('move the box to the left')).toBeNull();
  });

  it('does NOT match "what should I put under the heading"', () => {
    expect(parseFileUnderCommand('what should I put under the heading')).toBeNull();
  });

  it('does NOT match "move this to the top of the doc" (leading article after a weak preposition is a document-location phrase)', () => {
    // The tightened grammar rejects a leading article after to/into/in, so this document-location
    // phrase never parses as a filing command. That is the point of the tightening.
    expect(parseFileUnderCommand('move this to the top of the doc')).toBeNull();
  });
});

describe('heuristicProjectRoute', () => {
  it('matches a distinctive title token', () => {
    const r = heuristicProjectRoute('Acme weekly sync', '', projects);
    expect(r?.project.id).toBe('4');
    expect(r?.source).toBe('title');
  });

  it('returns null for the generic default title with no transcript', () => {
    expect(heuristicProjectRoute('Meeting 11_07_2026', '', projects)).toBeNull();
  });

  it('matches a project alias mentioned in the transcript', () => {
    const r = heuristicProjectRoute(null, 'we made progress on the joss integration today', projects);
    expect(r?.project.id).toBe('2');
    expect(r?.source).toBe('transcript');
  });

  it('requires a word boundary — "joseph" does not fire the Jos project', () => {
    expect(heuristicProjectRoute(null, 'I talked to joseph about the plan', projects)).toBeNull();
  });

  it('returns null when there are no registered projects', () => {
    expect(heuristicProjectRoute('Acme sync', 'acme acme acme', [])).toBeNull();
  });

  it('prefers the most-mentioned project in the transcript', () => {
    const r = heuristicProjectRoute(
      null,
      'first we discussed hirepath, then more hirepath, and once the meeting app',
      projects,
    );
    expect(r?.project.id).toBe('3');
  });
});
