import React, { useRef, useEffect, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ClaudeMessage, ClaudeToolCall } from '@/contexts/ClaudeContext';
import { TodoWriteBlock, parseTodoInput } from './TodoWriteBlock';
import { AskUserQuestionBlock, parseQuestionInput } from './AskUserQuestionBlock';

interface ConversationViewProps {
  messages: ClaudeMessage[];
  isStreaming: boolean;
  onAnswer?: (answer: string) => void;
}

function ToolCallBlock({ call }: { call: ClaudeToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="my-1 border border-border rounded text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1 px-2 py-1 bg-muted hover:bg-accent text-left rounded-t"
      >
        <Chevron className="w-3 h-3 text-muted-foreground" />
        <span className="font-mono text-muted-foreground">{call.name}</span>
      </button>
      {expanded && (
        <div className="px-2 py-1 space-y-1 border-t border-border max-h-[200px] overflow-auto">
          {call.input && (
            <div>
              <div className="text-muted-foreground mb-0.5">Input:</div>
              <pre className="whitespace-pre-wrap break-words text-muted-foreground bg-muted p-1 rounded">
                {call.input.length > 500 ? call.input.slice(0, 500) + '...' : call.input}
              </pre>
            </div>
          )}
          {call.output && (
            <div>
              <div className="text-muted-foreground mb-0.5">Output:</div>
              <pre className="whitespace-pre-wrap break-words text-muted-foreground bg-muted p-1 rounded">
                {call.output.length > 500 ? call.output.slice(0, 500) + '...' : call.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationView({ messages, isStreaming, onAnswer }: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 100;
    }
  };

  // Auto-scroll to bottom when new messages arrive (only if user is near bottom)
  // B019: Use requestAnimationFrame to ensure scrollHeight reflects new content
  useEffect(() => {
    if (isNearBottomRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
        <div className="text-center">
          <p>No conversation yet.</p>
          <p className="text-xs mt-1">Add context items and send a message to start.</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.map(msg => (
        <div key={msg.id} className={`${msg.role === 'user' ? 'flex justify-end' : ''}`}>
          {msg.role === 'user' ? (
            <div className="max-w-[85%]">
              {msg.contextSummary && (
                <div className="text-xs text-blue-500 mb-0.5 text-right">{msg.contextSummary}</div>
              )}
              <div className="bg-muted rounded-lg px-3 py-2 text-sm">
                {msg.text}
              </div>
            </div>
          ) : (
            <div className="max-w-[95%]">
              {msg.text && (
                <div className="text-sm break-words prose prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {isStreaming && msg === messages[messages.length - 1]
                      ? msg.text + ' \u258B'
                      : msg.text}
                  </ReactMarkdown>
                </div>
              )}
              {msg.toolCalls?.map((call, i) => {
                const key = `${msg.id}-tool-${i}`;
                if (call.name === 'TodoWrite' && parseTodoInput(call.input)) {
                  return <TodoWriteBlock key={key} call={call} />;
                }
                if (call.name === 'AskUserQuestion' && parseQuestionInput(call.input)) {
                  return <AskUserQuestionBlock key={key} call={call} onAnswer={onAnswer} />;
                }
                return <ToolCallBlock key={key} call={call} />;
              })}
              {msg.costUsd !== undefined && (
                <div className="text-xs text-muted-foreground mt-1">
                  Cost: ${msg.costUsd.toFixed(4)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
