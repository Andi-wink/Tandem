'use client'

import './globals.css'
import { Source_Sans_3 } from 'next/font/google'
import Sidebar from '@/components/Sidebar'
import { SidebarProvider } from '@/components/Sidebar/SidebarProvider'
import MainContent from '@/components/MainContent'
import AnalyticsProvider from '@/components/AnalyticsProvider'
import { Toaster, toast } from 'sonner'
import "sonner/dist/styles.css"
import { useState, useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RecordingStateProvider } from '@/contexts/RecordingStateContext'
import { OllamaDownloadProvider } from '@/contexts/OllamaDownloadContext'
import { TranscriptProvider } from '@/contexts/TranscriptContext'
import { ConfigProvider } from '@/contexts/ConfigContext'
import { OnboardingProvider } from '@/contexts/OnboardingContext'
import { OnboardingFlow } from '@/components/onboarding'
import { DownloadProgressToastProvider } from '@/components/shared/DownloadProgressToast'
import { UpdateCheckProvider } from '@/components/UpdateCheckProvider'
import { RecordingPostProcessingProvider } from '@/contexts/RecordingPostProcessingProvider'
import { ScreenshotProvider } from '@/contexts/ScreenshotContext'
import { ClipboardProvider } from '@/contexts/ClipboardContext'
import { ClaudeProvider } from '@/contexts/ClaudeContext'
import { ContextBasketProvider } from '@/contexts/ContextBasketContext'
import { SelectionProvider } from '@/contexts/SelectionContext'
import { ClaudePanel } from '@/components/ClaudePanel'
import { NotificationProvider } from '@/contexts/NotificationContext'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ThemeProvider } from 'next-themes'
import { ComposeProviders } from '@/components/ComposeProviders'
import { SoloModeProvider } from '@/contexts/SoloModeContext'
import { CanvasProvider } from '@/contexts/CanvasContext'
import { CanvasDevPanel } from '@/components/CanvasPanel/CanvasDevPanel'
import { logger } from '@/lib/logger'

const sourceSans3 = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-source-sans-3',
})

// export { metadata } from './metadata'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingCompleted, setOnboardingCompleted] = useState(false)

  useEffect(() => {
    // Check onboarding status first
    invoke<{ completed: boolean } | null>('get_onboarding_status')
      .then((status) => {
        const isComplete = status?.completed ?? false
        setOnboardingCompleted(isComplete)

        if (!isComplete) {
          logger.log('[Layout] Onboarding not completed, showing onboarding flow')
          setShowOnboarding(true)
        } else {
          logger.log('[Layout] Onboarding completed, showing main app')
        }
      })
      .catch((error) => {
        console.error('[Layout] Failed to check onboarding status:', error)
        // Default to showing onboarding if we can't check
        setShowOnboarding(true)
        setOnboardingCompleted(false)
      })
  }, [])

  // Disable context menu in production
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      const handleContextMenu = (e: MouseEvent) => e.preventDefault();
      document.addEventListener('contextmenu', handleContextMenu);
      return () => document.removeEventListener('contextmenu', handleContextMenu);
    }
  }, []);
  useEffect(() => {
    // Listen for tray recording toggle request
    const unlisten = listen('request-recording-toggle', () => {
      logger.log('[Layout] Received request-recording-toggle from tray');

      if (showOnboarding) {
        toast.error("Please complete setup first", {
          description: "You need to finish onboarding before you can start recording."
        });
      } else {
        // If in main app, forward to useRecordingStart via window event
        logger.log('[Layout] Forwarding to start-recording-from-sidebar');
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [showOnboarding]);

  const handleOnboardingComplete = () => {
    logger.log('[Layout] Onboarding completed, reloading app')
    setShowOnboarding(false)
    setOnboardingCompleted(true)
    // Optionally reload the window to ensure all state is fresh
    window.location.reload()
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sourceSans3.variable} font-sans antialiased`}>
        {/* R010: Flat provider list instead of 15-deep nesting pyramid */}
        <ComposeProviders providers={[
          [ThemeProvider, { attribute: 'class', defaultTheme: 'dark', storageKey: 'tandem-theme', enableSystem: false }],
          [AnalyticsProvider],
          [RecordingStateProvider],
          [TranscriptProvider],
          [ConfigProvider],
          [OllamaDownloadProvider],
          [OnboardingProvider],
          [UpdateCheckProvider],
          [SidebarProvider],
          [TooltipProvider],
          [RecordingPostProcessingProvider],
          [ClipboardProvider],
          [ScreenshotProvider],
          [SelectionProvider],
          [NotificationProvider],  // SSE connection to backend /api/notify/stream
          [SoloModeProvider],
          [ContextBasketProvider],  // R009: Must be above ClaudeProvider
          [ClaudeProvider],
          [CanvasProvider],  // Voice-driven canvas host glue (drives the agent-whiteboard window)
        ]}>
          {/* Download progress toast provider - listens for background downloads */}
          <DownloadProgressToastProvider />

          {/* Show onboarding or main app */}
          {showOnboarding ? (
            <OnboardingFlow onComplete={handleOnboardingComplete} />
          ) : (
            <div className="flex">
              <ErrorBoundary fallbackLabel="Sidebar">
                <Sidebar />
              </ErrorBoundary>
              <ErrorBoundary fallbackLabel="Main content">
                <MainContent>{children}</MainContent>
              </ErrorBoundary>
              <ErrorBoundary fallbackLabel="AI Panel">
                <ClaudePanel />
              </ErrorBoundary>
              <ErrorBoundary fallbackLabel="Canvas">
                <CanvasDevPanel />
              </ErrorBoundary>
            </div>
          )}
        </ComposeProviders>
        <Toaster position="bottom-center" richColors closeButton />
      </body>
    </html>
  )
}
