import React, { useRef, useEffect, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { ClaudeMessage, ClaudeToolCall } from '@/contexts/ClaudeContext';
import { TodoWriteBlock, parseTodoInput } from './TodoWriteBlock';
import { AskUserQuestionBlock, parseQuestionInput } from './AskUserQuestionBlock';
import { DiagramBlock, isDiagramToolCall } from './DiagramBlock';
import { MermaidBlock } from './MermaidBlock';

// B042: Custom link component that opens HTTP(S) links in the system browser instead of Tauri webview
const MarkdownLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = ({ href, children, ...props }) => (
  <a
    href={href}
    onClick={(e) => {
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        e.preventDefault();
        invoke('open_external_url', { url: href }).catch(console.error);
      }
    }}
    className="text-brand hover:underline cursor-pointer"
    {...props}
  >
    {children}
  </a>
);

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
      <div className="flex-1 flex items-center justify-center text-muted-foreground p-6">
        <div className="text-center space-y-2">
          <p className="text-sm">No conversation yet</p>
          <p className="text-xs text-muted-foreground/60">Send a message or type / for commands</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
      {messages.map(msg => (
        <div key={msg.id} className={`${msg.role === 'user' ? 'flex justify-end' : ''}`}>
          {msg.role === 'user' ? (
            <div className="max-w-[85%]">
              {msg.contextSummary && (
                <div className="text-xs text-brand mb-1 text-right">{msg.contextSummary}</div>
              )}
              <div className="bg-muted rounded-2xl px-4 py-2.5 text-sm leading-relaxed">
                {msg.text}
              </div>
            </div>
          ) : (
            <div className="max-w-full">
              {msg.text && (
                <div className="text-sm break-words prose prose-sm max-w-none prose-p:leading-relaxed prose-p:mb-3 prose-headings:mb-2 prose-headings:mt-4 prose-li:my-0.5 prose-ul:my-2 prose-ol:my-2 dark:prose-invert">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: MarkdownLink,
                      code({ className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || '');
                        if (match && match[1] === 'mermaid') {
                          const code = String(children).replace(/\n$/, '');
                          return <MermaidBlock code={code} />;
                        }
                        return <code className={className} {...props}>{children}</code>;
                      },
                      pre({ children }) {
                        const child = React.Children.only(children) as React.ReactElement;
                        if (child?.type === MermaidBlock) return <>{children}</>;
                        return <pre>{children}</pre>;
                      },
                    }}
                  >
                    {isStreaming && msg.id === messages[messages.length - 1]?.id
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
                if (isDiagramToolCall(call)) {
                  return <DiagramBlock key={key} call={call} />;
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
