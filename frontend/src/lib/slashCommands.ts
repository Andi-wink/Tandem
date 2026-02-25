// F018: Slash command registry for AI panel
// Each command has a prompt template with {transcript_context} and {user_input} placeholders.
// Built-in commands are always available. Users can add custom commands via Settings > Commands.

export interface SlashCommand {
  name: string;
  description: string;
  icon: string; // lucide-react icon name
  promptTemplate: string;
  isBuiltIn?: boolean; // true for default commands, false/undefined for user-created
  type?: 'ai' | 'action'; // F020: 'ai' = send to Claude (default), 'action' = execute locally
  action?: string;         // F020: action identifier (e.g., 'handoff')
}

const STORAGE_KEY = 'tandem_custom_commands';

export const BUILT_IN_COMMANDS: SlashCommand[] = [
  {
    name: 'research',
    description: 'Research a topic using conversation context',
    icon: 'Search',
    isBuiltIn: true,
    promptTemplate: `You are a research assistant. Based on the live conversation transcript below, research and provide insights on the following topic.

{user_input_section}

## Live Conversation Context
{transcript_context}

Provide a well-structured analysis with key findings, relevant details, and actionable takeaways.`,
  },
  {
    name: 'summarize',
    description: 'Summarize the conversation so far',
    icon: 'FileText',
    isBuiltIn: true,
    promptTemplate: `Summarize the following conversation concisely. Highlight the key points, decisions made, and any open questions.

{user_input_section}

## Conversation
{transcript_context}`,
  },
  {
    name: 'actions',
    description: 'Extract action items and next steps',
    icon: 'ListChecks',
    isBuiltIn: true,
    promptTemplate: `Extract all action items, next steps, and commitments from the following conversation. For each item, identify who is responsible (if mentioned) and any deadlines.

{user_input_section}

## Conversation
{transcript_context}

Format as a clear checklist with owners and deadlines where applicable.`,
  },
  {
    name: 'objections',
    description: 'List objections and concerns raised',
    icon: 'ShieldAlert',
    isBuiltIn: true,
    promptTemplate: `Identify all objections, concerns, hesitations, and pushback raised during this conversation. For each objection, note who raised it and any responses given.

{user_input_section}

## Conversation
{transcript_context}

Categorize by severity (blocking, significant, minor) and whether they were addressed.`,
  },
  {
    name: 'pain-points',
    description: 'Identify customer pain points discussed',
    icon: 'AlertTriangle',
    isBuiltIn: true,
    promptTemplate: `Analyze the following conversation to identify all customer pain points, frustrations, and unmet needs. Include both explicitly stated problems and implied ones.

{user_input_section}

## Conversation
{transcript_context}

For each pain point, note: what the problem is, how severe it seems, and any solutions discussed.`,
  },
  {
    name: 'brief',
    description: 'Generate a quick meeting brief',
    icon: 'ClipboardList',
    isBuiltIn: true,
    promptTemplate: `Generate a concise meeting brief from the following conversation. Include:
- **Attendees/Participants** (if identifiable)
- **Key Topics Discussed**
- **Decisions Made**
- **Action Items**
- **Open Questions**
- **Follow-up Needed**

{user_input_section}

## Conversation
{transcript_context}`,
  },
  // F020: Action command — exports meeting data as HANDOFF.md
  {
    name: 'handoff',
    description: 'Export meeting as HANDOFF.md for Claude Code',
    icon: 'Download',
    isBuiltIn: true,
    type: 'action',
    action: 'handoff',
    promptTemplate: '',
  },
];

// ─── Custom command persistence ─────────────────────────────────────────────

export function loadCustomCommands(): SlashCommand[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SlashCommand[];
    return parsed.map(cmd => ({ ...cmd, isBuiltIn: false }));
  } catch {
    return [];
  }
}

export function saveCustomCommands(commands: SlashCommand[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(commands));
}

// ─── Unified command list ───────────────────────────────────────────────────

/** Get all commands (built-in + custom). Custom commands with duplicate names override built-ins. */
export function getAllCommands(): SlashCommand[] {
  const custom = loadCustomCommands();
  const customNames = new Set(custom.map(c => c.name));
  // Built-ins first (filtered to remove overridden), then custom
  const builtIns = BUILT_IN_COMMANDS.filter(c => !customNames.has(c.name));
  return [...builtIns, ...custom];
}

/** Filter commands matching a partial input (e.g., "/res" matches "/research") */
export function matchCommands(input: string): SlashCommand[] {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed.startsWith('/')) return [];
  const query = trimmed.slice(1); // strip leading "/"
  const all = getAllCommands();
  if (query.length === 0) return all;
  return all.filter(cmd => cmd.name.startsWith(query));
}

/** Extract the command name and remaining user input from the textarea value */
export function parseCommandInput(input: string): { commandName: string; userInput: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return { commandName: trimmed.slice(1), userInput: '' };
  }
  return {
    commandName: trimmed.slice(1, spaceIdx),
    userInput: trimmed.slice(spaceIdx + 1).trim(),
  };
}

/** Fill the prompt template with transcript context and user input */
export function expandTemplate(
  cmd: SlashCommand,
  transcriptText: string,
  userInput: string,
): string {
  const userInputSection = userInput
    ? `## Additional Instructions\n${userInput}`
    : '';
  const contextText = transcriptText || '(No live transcript — recording is not active or no speech detected yet)';
  return cmd.promptTemplate
    .replace('{user_input_section}', userInputSection)
    .replace('{transcript_context}', contextText);
}
