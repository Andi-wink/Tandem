'use client';

import React from 'react';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useClaude } from '@/contexts/ClaudeContext';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  const { isCollapsed } = useSidebar();
  const { isPanelOpen, panelWidth } = useClaude();

  return (
    <main
      className={`flex-1 transition-all duration-300 ${
        isCollapsed ? 'ml-16' : 'ml-64'
      }`}
      style={{ marginRight: isPanelOpen ? panelWidth : 0 }}
    >
      <div className="pl-8">
        {children}
      </div>
    </main>
  );
};

export default MainContent;
