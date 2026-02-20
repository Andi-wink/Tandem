import React, { useRef, useEffect, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { ClaudeMessage, ClaudeToolCall } from '@/contexts/ClaudeContext';

interface ConversationViewProps {
  messages: ClaudeMessage[];
  isStreaming: boolean;
}

function ToolCallBlock({ call }: { call: ClaudeToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="my-1 border border-gray-200 rounded text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1 px-2 py-1 bg-gray-50 hover:bg-gray-100 text-left rounded-t"
      >
        <Chevron className="w-3 h-3 text-gray-500" />
        <span className="font-mono text-gray-600">{call.name}</span>
      </button>
      {expanded && (
        <div className="px-2 py-1 space-y-1 border-t border-gray-100 max-h-[200px] overflow-auto">
          {call.input && (
            <div>
              <div className="text-gray-400 mb-0.5">Input:</div>
              <pre className="whitespace-pre-wrap break-words text-gray-600 bg-gray-50 p-1 rounded">
                {call.input.length > 500 ? call.input.slice(0, 500) + '...' : call.input}
              </pre>
            </div>
          )}
          {call.output && (
            <div>
              <div className="text-gray-400 mb-0.5">Output:</div>
              <pre className="whitespace-pre-wrap break-words text-gray-600 bg-gray-50 p-1 rounded">
                {call.output.length > 500 ? call.output.slice(0, 500) + '...' : call.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationView({ messages, isStreaming }: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm p-4">
        <div className="text-center">
          <p>No conversation yet.</p>
          <p className="text-xs mt-1">Add context items and send a message to start.</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.map(msg => (
        <div key={msg.id} className={`${msg.role === 'user' ? 'flex justify-end' : ''}`}>
          {msg.role === 'user' ? (
            <div className="max-w-[85%]">
              {msg.contextSummary && (
                <div className="text-xs text-blue-500 mb-0.5 text-right">{msg.contextSummary}</div>
              )}
              <div className="bg-gray-100 rounded-lg px-3 py-2 text-sm">
                {msg.text}
              </div>
            </div>
          ) : (
            <div className="max-w-[95%]">
              {msg.text && (
                <div className="text-sm whitespace-pre-wrap break-words prose prose-sm max-w-none">
                  {msg.text}
                  {isStreaming && msg === messages[messages.length - 1] && (
                    <span className="inline-block w-1.5 h-4 bg-gray-400 ml-0.5 animate-pulse" />
                  )}
                </div>
              )}
              {msg.toolCalls?.map((call, i) => (
                <ToolCallBlock key={`${msg.id}-tool-${i}`} call={call} />
              ))}
              {msg.costUsd !== undefined && (
                <div className="text-xs text-gray-400 mt-1">
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
