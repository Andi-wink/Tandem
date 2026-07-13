import { describe, it, expect } from 'vitest';
import { resolveFiledUnder } from './filedUnder';

const projects = [
  { name: 'Acme', path: 'D:/Dev-projects/Client_projects/Acme' },
  { name: 'Globex', path: 'D:/Dev-projects/Client_projects/Globex' },
];

describe('resolveFiledUnder', () => {
  it('returns unfiled for a null/empty folder path', () => {
    expect(resolveFiledUnder(null, projects).filed).toBe(false);
    expect(resolveFiledUnder(undefined, projects).filed).toBe(false);
    expect(resolveFiledUnder('', projects).filed).toBe(false);
  });

  it('returns unfiled for a folder in the default recordings location', () => {
    const r = resolveFiledUnder('C:/Users/test/.meetily/recordings/Standup 2026-02-23', projects);
    expect(r.filed).toBe(false);
    expect(r.projectName).toBeUndefined();
  });

  it('resolves a folder under <project>/.tandem to that project', () => {
    const r = resolveFiledUnder(
      'D:/Dev-projects/Client_projects/Acme/.tandem/Standup 2026-02-23',
      projects,
    );
    expect(r.filed).toBe(true);
    expect(r.projectName).toBe('Acme');
    expect(r.projectPath).toBe('D:/Dev-projects/Client_projects/Acme');
  });

  it('is separator- and case-insensitive', () => {
    const r = resolveFiledUnder(
      'd:\\dev-projects\\client_projects\\acme\\.tandem\\Meeting',
      projects,
    );
    expect(r.filed).toBe(true);
    expect(r.projectName).toBe('Acme');
  });

  it('treats the bare .tandem dir as filed', () => {
    const r = resolveFiledUnder('D:/Dev-projects/Client_projects/Globex/.tandem', projects);
    expect(r.filed).toBe(true);
    expect(r.projectName).toBe('Globex');
  });

  it('does not match a sibling folder that only shares the .tandem prefix', () => {
    // "...Acme/.tandemONNAME/..." must NOT count as filed under Acme's .tandem.
    const r = resolveFiledUnder(
      'D:/Dev-projects/Client_projects/Acme/.tandemONNAME/Meeting',
      projects,
    );
    expect(r.filed).toBe(false);
  });

  it('picks the most specific (deepest) project when roots are nested', () => {
    const nested = [
      { name: 'Monorepo', path: 'D:/work' },
      { name: 'ClientA', path: 'D:/work/ClientA' },
    ];
    const r = resolveFiledUnder('D:/work/ClientA/.tandem/Kickoff', nested);
    expect(r.projectName).toBe('ClientA');
  });

  it('ignores projects with an empty path', () => {
    const r = resolveFiledUnder('D:/anything/.tandem/x', [{ name: 'Bad', path: '' }]);
    expect(r.filed).toBe(false);
  });
});
