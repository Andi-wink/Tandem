import { Project } from '@/services/projectService';

export interface SoloTask {
  id: string;
  description: string;
  projectName: string;
  projectPath: string;
  timestamp: number;
  routed: boolean;
}

export interface ProjectHistoryEntry {
  project: Project;
  startIndex: number;
  endIndex: number | null;
  startTime: number; // Date.now()
}

export interface RoutingDecision {
  project_switch: {
    detected: boolean;
    project_name: string | null;
    confidence: number;
  };
  intents: Array<{
    description: string;
    confidence: number;
  }>;
  notes: Array<{
    description: string;
    confidence: number;
  }>;
  stop_detected: boolean;
  /** True when the user just retracted the previous intent ("ignore that", "not a task", "never mind"). */
  revoke_last: boolean;
}
