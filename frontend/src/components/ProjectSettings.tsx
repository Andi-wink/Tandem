'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { FolderGit2, Trash2, Plus, Search, X, Cpu, PanelTop } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { useSoloMode, SOLO_HUD_ENABLED_KEY } from '@/contexts/SoloModeContext';
import {
  Project,
  ScannedProject,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  importScannedProjects,
  scanDirectory,
  pickDirectory,
} from '@/services/projectService';

const DEFAULT_SCAN_ROOT = 'D:\\Dev-projects';

export function ProjectSettings() {
  const { routingModel, setRoutingModel } = useSoloMode();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [scanResults, setScanResults] = useState<ScannedProject[] | null>(null);
  const [selectedScanned, setSelectedScanned] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [scanRoot, setScanRoot] = useState(DEFAULT_SCAN_ROOT);
  const [hudEnabled, setHudEnabled] = useState(true);

  // Add project form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newAliases, setNewAliases] = useState('');

  // Editing aliases
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAliases, setEditAliases] = useState('');

  const loadProjects = useCallback(async () => {
    try {
      const result = await listProjects();
      setProjects(result);
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Load the floating HUD toggle (default ON when unset)
  useEffect(() => {
    setHudEnabled(localStorage.getItem(SOLO_HUD_ENABLED_KEY) !== 'false');
  }, []);

  const handleToggleHud = useCallback(() => {
    setHudEnabled(prev => {
      const next = !prev;
      localStorage.setItem(SOLO_HUD_ENABLED_KEY, next ? 'true' : 'false');
      return next;
    });
  }, []);

  // Load Ollama models for routing model selector
  useEffect(() => {
    invoke<Array<{ name: string }>>('get_ollama_models', { endpoint: null })
      .then(models => setOllamaModels(models.map(m => m.name)))
      .catch(() => {});
  }, []);

  const handleBrowseScanRoot = async () => {
    try {
      const dir = await pickDirectory(scanRoot || DEFAULT_SCAN_ROOT);
      if (dir) setScanRoot(dir);
    } catch (err) {
      console.warn('Browse failed:', err);
    }
  };

  const handleScan = async () => {
    if (!scanRoot.trim()) {
      toast.error('Enter a directory to scan');
      return;
    }
    setIsScanning(true);
    try {
      const results = await scanDirectory(scanRoot.trim());
      setScanResults(results);
      // Pre-select all that aren't already registered
      const existingPaths = new Set(projects.map(p => p.path));
      const newSelected = new Set<string>();
      results.forEach(r => {
        if (!existingPaths.has(r.path)) {
          newSelected.add(r.path);
        }
      });
      setSelectedScanned(newSelected);
      if (results.length === 0) {
        toast.info('No projects found in that directory');
      }
    } catch (err) {
      toast.error('Scan failed', { description: String(err) });
    } finally {
      setIsScanning(false);
    }
  };

  const handleImport = async () => {
    if (selectedScanned.size === 0 || !scanResults) return;
    setIsImporting(true);
    try {
      const toImport = scanResults.filter(r => selectedScanned.has(r.path));
      const imported = await importScannedProjects(toImport);
      toast.success(`Imported ${imported.length} project${imported.length !== 1 ? 's' : ''}`);
      setScanResults(null);
      setSelectedScanned(new Set());
      await loadProjects();
    } catch (err) {
      toast.error('Import failed', { description: String(err) });
    } finally {
      setIsImporting(false);
    }
  };

  const handleAddManual = async () => {
    if (!newName.trim() || !newPath.trim()) {
      toast.error('Name and path are required');
      return;
    }
    try {
      const aliases = newAliases
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);
      await createProject(newName.trim(), newPath.trim(), aliases);
      toast.success(`Added ${newName.trim()}`);
      setShowAddForm(false);
      setNewName('');
      setNewPath('');
      setNewAliases('');
      await loadProjects();
    } catch (err) {
      toast.error('Failed to add project', { description: String(err) });
    }
  };

  const handlePickPath = async () => {
    const dir = await pickDirectory(DEFAULT_SCAN_ROOT);
    if (dir) {
      setNewPath(dir);
      if (!newName.trim()) {
        const parts = dir.replace(/\\/g, '/').split('/');
        setNewName(parts[parts.length - 1] || '');
      }
    }
  };

  const handleDelete = async (id: string, name: string) => {
    try {
      await deleteProject(id);
      toast.success(`Removed ${name}`);
      await loadProjects();
    } catch (err) {
      toast.error('Failed to delete', { description: String(err) });
    }
  };

  const handleSaveAliases = async (project: Project) => {
    try {
      const aliases = editAliases
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);
      await updateProject(project.id, project.name, project.path, aliases);
      setEditingId(null);
      await loadProjects();
    } catch (err) {
      toast.error('Failed to update aliases', { description: String(err) });
    }
  };

  const existingPaths = new Set(projects.map(p => p.path));

  return (
    <div className="space-y-6 py-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Projects</h2>
        <p className="text-sm text-muted-foreground">
          Register projects for Solo Mode. When you say a project name during a solo recording, tasks and transcript will be routed to that project.
        </p>
      </div>

      {/* Routing Model */}
      <div className="border border-border rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={16} className="text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Routing Model</p>
            <p className="text-xs text-muted-foreground">Local LLM that detects project switches and tasks</p>
          </div>
        </div>
        <select
          value={routingModel}
          onChange={e => setRoutingModel(e.target.value)}
          className="px-3 py-1.5 rounded-md border border-border bg-background text-sm min-w-[180px]"
        >
          {ollamaModels.length > 0 ? (
            ollamaModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))
          ) : (
            <option value={routingModel}>{routingModel} (Ollama not connected)</option>
          )}
        </select>
      </div>

      {/* Floating HUD toggle */}
      <div className="border border-border rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PanelTop size={16} className="text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Floating project HUD</p>
            <p className="text-xs text-muted-foreground">
              Always-on-top overlay showing the active project during a solo session. Click it to correct a misroute.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={hudEnabled}
          onClick={handleToggleHud}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
            hudEnabled ? 'bg-brand' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              hudEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Scan + Add */}
      <div className="space-y-3">
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground mb-1 block">Scan root directory</label>
            <div className="flex gap-2">
              <input
                value={scanRoot}
                onChange={e => setScanRoot(e.target.value)}
                placeholder="D:\Dev-projects"
                className="flex-1 px-3 py-1.5 rounded-md border border-border bg-background text-sm"
              />
              <button
                onClick={handleBrowseScanRoot}
                className="px-3 py-1.5 border border-border rounded-md hover:bg-muted text-sm"
              >
                Browse
              </button>
            </div>
          </div>
          <button
            onClick={handleScan}
            disabled={isScanning}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 text-sm font-medium h-[34px]"
          >
            <Search size={16} />
            {isScanning ? 'Scanning...' : 'Scan'}
          </button>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-2 px-3 py-1.5 bg-muted text-foreground rounded-lg hover:bg-muted/80 text-sm font-medium"
        >
          <Plus size={16} />
          Add Manually
        </button>
      </div>

      {/* Scan Results */}
      {scanResults && (
        <div className="border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              Found {scanResults.length} project{scanResults.length !== 1 ? 's' : ''}
            </h3>
            <button onClick={() => setScanResults(null)} className="text-muted-foreground hover:text-foreground">
              <X size={16} />
            </button>
          </div>
          {scanResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">No projects found in the selected directory.</p>
          ) : (
            <>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {scanResults.map(r => {
                  const alreadyExists = existingPaths.has(r.path);
                  return (
                    <label
                      key={r.path}
                      className={`flex items-center gap-2 py-1.5 px-2 rounded text-sm ${
                        alreadyExists ? 'opacity-50' : 'hover:bg-muted/50 cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedScanned.has(r.path)}
                        disabled={alreadyExists}
                        onChange={(e) => {
                          const next = new Set(selectedScanned);
                          if (e.target.checked) next.add(r.path);
                          else next.delete(r.path);
                          setSelectedScanned(next);
                        }}
                        className="rounded"
                      />
                      <span className="font-medium">{r.name}</span>
                      <span className="text-muted-foreground truncate text-xs">{r.path}</span>
                      {alreadyExists && <span className="text-xs text-muted-foreground ml-auto">(already added)</span>}
                    </label>
                  );
                })}
              </div>
              <button
                onClick={handleImport}
                disabled={selectedScanned.size === 0 || isImporting}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 text-sm font-medium"
              >
                {isImporting ? 'Importing...' : `Import ${selectedScanned.size} Selected`}
              </button>
            </>
          )}
        </div>
      )}

      {/* Add Manual Form */}
      {showAddForm && (
        <div className="border border-border rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold">Add Project</h3>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-muted-foreground">Name</label>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="My Project"
                className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Path</label>
              <div className="flex gap-2">
                <input
                  value={newPath}
                  onChange={e => setNewPath(e.target.value)}
                  placeholder="D:\Dev projects\MyProject"
                  className="flex-1 px-3 py-1.5 rounded-md border border-border bg-background text-sm"
                />
                <button
                  onClick={handlePickPath}
                  className="px-3 py-1.5 border border-border rounded-md hover:bg-muted text-sm"
                >
                  Browse
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Aliases (comma-separated)</label>
              <input
                value={newAliases}
                onChange={e => setNewAliases(e.target.value)}
                placeholder="my project, the auth app"
                className="w-full px-3 py-1.5 rounded-md border border-border bg-background text-sm"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleAddManual}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 text-sm font-medium"
            >
              Add
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="px-4 py-2 bg-muted text-foreground rounded-lg hover:bg-muted/80 text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Projects Table */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading projects...</p>
      ) : projects.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center">
          <FolderGit2 className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            No projects registered yet. Scan a directory or add one manually.
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">Path</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">Aliases</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {projects.map(project => (
                <tr key={project.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-2.5 font-medium">{project.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs truncate max-w-[250px]" title={project.path}>
                    {project.path}
                  </td>
                  <td className="px-4 py-2.5">
                    {editingId === project.id ? (
                      <div className="flex gap-1">
                        <input
                          value={editAliases}
                          onChange={e => setEditAliases(e.target.value)}
                          className="flex-1 px-2 py-0.5 rounded border border-border bg-background text-xs"
                          placeholder="alias1, alias2"
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveAliases(project); }}
                        />
                        <button
                          onClick={() => handleSaveAliases(project)}
                          className="text-xs text-primary hover:underline"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="text-xs text-muted-foreground hover:underline"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div
                        className="flex flex-wrap gap-1 cursor-pointer"
                        onClick={() => {
                          setEditingId(project.id);
                          setEditAliases(project.aliases.join(', '));
                        }}
                      >
                        {project.aliases.length > 0 ? (
                          project.aliases.map((a, i) => (
                            <span key={i} className="px-1.5 py-0.5 rounded bg-muted text-xs">
                              {a}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground italic">click to add</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    <button
                      onClick={() => handleDelete(project.id, project.name)}
                      className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
