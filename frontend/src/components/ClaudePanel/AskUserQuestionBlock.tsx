import React from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { ClaudeToolCall } from '@/contexts/ClaudeContext';

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AskUserQuestionInput {
  questions: Question[];
}

export function parseQuestionInput(input: string): AskUserQuestionInput | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed?.questions && Array.isArray(parsed.questions)) {
      return parsed as AskUserQuestionInput;
    }
  } catch {
    // malformed JSON
  }
  return null;
}

function parseAnswer(output: string | undefined): string | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    if (parsed?.answers && typeof parsed.answers === 'object') {
      return Object.values(parsed.answers).join(', ');
    }
    if (typeof parsed === 'string') return parsed;
  } catch {
    // not JSON, use as-is
  }
  return output.length > 200 ? output.slice(0, 200) + '...' : output;
}

export function AskUserQuestionBlock({ call }: { call: ClaudeToolCall }) {
  const data = parseQuestionInput(call.input);

  if (!data) return null; // caller should fall back to generic ToolCallBlock

  const answer = parseAnswer(call.output);

  return (
    <div className="my-1 border border-border rounded text-xs">
      {data.questions.map((q, qi) => (
        <div key={qi} className={qi > 0 ? 'border-t border-border' : ''}>
          <div className="flex items-center gap-1.5 px-2 py-1 bg-muted rounded-t">
            <MessageCircleQuestion className="w-3 h-3 text-muted-foreground flex-shrink-0" />
            {q.header && (
              <span className="px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded text-[10px] font-medium">
                {q.header}
              </span>
            )}
          </div>
          <div className="px-2 py-1.5 space-y-1.5">
            <p className="text-foreground">{q.question}</p>
            <div className="flex flex-wrap gap-1">
              {q.options.map((opt, oi) => (
                <span
                  key={oi}
                  className="inline-flex px-2 py-0.5 rounded-full border border-border bg-muted text-muted-foreground"
                  title={opt.description}
                >
                  {opt.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      ))}
      {answer && (
        <div className="px-2 py-1.5 border-t border-border bg-emerald-50 dark:bg-emerald-900/10">
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">Answer: </span>
          <span className="text-foreground">{answer}</span>
        </div>
      )}
    </div>
  );
}
