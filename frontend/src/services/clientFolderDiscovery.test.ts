import { describe, it, expect } from 'vitest';
import { discoveredAsProjectStubs, isDiscoveredStub, DISCOVERED_PREFIX } from './clientFolderDiscovery';
import { Project } from '@/services/projectService';

function proj(name: string, path: string): Project {
  return { id: name.toLowerCase(), name, path, aliases: [], auto_discovered: false, session_id: null, created_at: '' };
}

describe('discoveredAsProjectStubs', () => {
  it('maps discovered folders to project stubs with a discovered id', () => {
    const stubs = discoveredAsProjectStubs(
      [{ name: 'ARO', path: 'D:/Dev-projects/Client_projects/ARO' }],
      [],
    );
    expect(stubs).toHaveLength(1);
    expect(stubs[0].name).toBe('ARO');
    expect(stubs[0].path).toBe('D:/Dev-projects/Client_projects/ARO');
    expect(stubs[0].id.startsWith(DISCOVERED_PREFIX)).toBe(true);
    expect(isDiscoveredStub(stubs[0])).toBe(true);
  });

  it('drops a discovered folder that collides with a registered project (registered wins)', () => {
    const registered = [proj('Openclaw', 'D:/Dev-projects/Client_projects/Openclaw')];
    const stubs = discoveredAsProjectStubs(
      [
        { name: 'Openclaw', path: 'D:/Dev-projects/Client_projects/Openclaw' }, // collides
        { name: 'n8n', path: 'D:/Dev-projects/Client_projects/n8n' },
      ],
      registered,
    );
    expect(stubs.map(s => s.name)).toEqual(['n8n']);
  });

  it('dedupes discovered folders that normalize to the same path', () => {
    const stubs = discoveredAsProjectStubs(
      [
        { name: 'ARO', path: 'D:/Dev-projects/Client_projects/ARO' },
        { name: 'ARO', path: 'D:\\Dev-projects\\Client_projects\\ARO\\' }, // same after normalize
      ],
      [],
    );
    expect(stubs).toHaveLength(1);
  });

  it('collision check is case-insensitive and separator-insensitive', () => {
    const registered = [proj('ARO', 'd:\\dev-projects\\client_projects\\aro')];
    const stubs = discoveredAsProjectStubs(
      [{ name: 'ARO', path: 'D:/Dev-projects/Client_projects/ARO' }],
      registered,
    );
    expect(stubs).toHaveLength(0);
  });
});
