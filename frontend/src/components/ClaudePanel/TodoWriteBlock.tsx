import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Circle, Loader2, CheckCircle2, ListTodo } from 'lucide-react';
import { ClaudeToolCall } from '@/contexts/ClaudeContext';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

interface TodoWriteInput {
  todos: TodoItem[];
}

export function parseTodoInput(input: string): TodoWriteInput | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed?.todos && Array.isArray(parsed.todos)) {
      return parsed as TodoWriteInput;
    }
  } catch {
    // malformed JSON
  }
  return null;
}

const STATUS_CONFIG = {
  pending: {
    icon: Circle,
    className: 'text-muted-foreground',
    textClass: 'text-muted-foreground',
  },
  in_progress: {
    icon: Loader2,
    className: 'text-brand animate-spin',
    textClass: 'text-foreground font-medium',
  },
  completed: {
    icon: CheckCircle2,
    className: 'text-success',
    textClass: 'text-muted-foreground line-through',
  },
} as const;

export function TodoWriteBlock({ call }: { call: ClaudeToolCall }) {
  const [collapsed, setCollapsed] = useState(false);
  const data = parseTodoInput(call.input);

  if (!data) return null; // caller should fall back to generic ToolCallBlock

  const completedCount = data.todos.filter(t => t.status === 'completed').length;
  const total = data.todos.length;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div className="my-1 border border-border rounded text-xs">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-1.5 px-2 py-1 bg-muted hover:bg-accent text-left rounded-t"
      >
        <Chevron className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        <ListTodo className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        <span className="text-muted-foreground font-medium">Task List</span>
        <span className="text-muted-foreground ml-auto">{completedCount}/{total}</span>
      </button>
      {!collapsed && (
        <ul className="px-2 py-1.5 space-y-1">
          {data.todos.map((todo, i) => {
            const config = STATUS_CONFIG[todo.status] || STATUS_CONFIG.pending;
            const Icon = config.icon;
            return (
              <li key={i} className="flex items-start gap-1.5">
                <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${config.className}`} />
                <span className={config.textClass}>{todo.content}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
