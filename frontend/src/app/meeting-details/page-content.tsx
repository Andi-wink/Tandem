"use client";
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Summary, SummaryResponse, ScreenshotData, ClipboardData } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { SummaryPanel } from '@/components/MeetingDetails/SummaryPanel';
import { FiledUnderRow } from '@/components/MeetingDetails/FiledUnderRow';
import { MeetingNotesSection } from '@/components/MeetingDetails/MeetingNotesSection';
import { ModelConfig } from '@/components/ModelSettingsModal';

// Custom hooks
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useConfig } from '@/contexts/ConfigContext';
import { useClaude } from '@/contexts/ClaudeContext';
import { Bot, PenTool, Users, Loader2 } from 'lucide-react';
import {
  startDiarization,
  getDiarizationStatus,
  getDiarizationResult,
  getDiarizationHealth,
} from '@/services/diarizationService';
import { SpeakerNamingModal } from '@/components/SpeakerNamingModal';
import { formatSpeakerLabel } from '@/lib/speakerColors';

export default function PageContent({
  meeting,
  summaryData,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onMeetingUpdated,
  // Pagination props for efficient transcript loading
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  screenshots,
  clipboardItems,
}: {
  meeting: any;
  summaryData: Summary | null;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  // Pagination props
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
  // Screenshot and clipboard data
  screenshots?: ScreenshotData[];
  clipboardItems?: ClipboardData[];
}) {
  console.log('📄 PAGE CONTENT: Initializing with data:', {
    meetingId: meeting.id,
    summaryDataKeys: summaryData ? Object.keys(summaryData) : null,
    transcriptsCount: meeting.transcripts?.length
  });

  // State
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [isRecording] = useState(false);
  const [summaryResponse] = useState<SummaryResponse | null>(null);

  // F022: Speaker diarization state
  const [diarAvailable, setDiarAvailable] = useState(false);
  const [diarStatus, setDiarStatus] = useState<string | null>(null); // null | pending | processing | completed | failed
  const [diarProgress, setDiarProgress] = useState(0);
  const [showNamingModal, setShowNamingModal] = useState(false);
  const [diarSpeakerLabels, setDiarSpeakerLabels] = useState<string[]>([]);
  const [diarSampleQuotes, setDiarSampleQuotes] = useState<Record<string, string>>({});
  const [diarSpeakerNames, setDiarSpeakerNames] = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Ref to store the modal open function from SummaryGeneratorButtonGroup
  const openModelSettingsRef = useRef<(() => void) | null>(null);

  // Sidebar context
  const { serverAddress } = useSidebar();

  // Get model config from ConfigContext
  const { modelConfig, setModelConfig } = useConfig();

  // Claude panel
  const { isPanelOpen, openPanel } = useClaude();

  // Custom hooks
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();

  // Callback to register the modal open function
  const handleRegisterModalOpen = (openFn: () => void) => {
    console.log('📝 Registering modal open function in PageContent');
    openModelSettingsRef.current = openFn;
  };

  // Callback to trigger modal open (called from error handler)
  const handleOpenModelSettings = () => {
    console.log('🔔 Opening model settings from PageContent');
    if (openModelSettingsRef.current) {
      openModelSettingsRef.current();
    } else {
      console.warn('⚠️ Modal open function not yet registered');
    }
  };

  // Save model config to backend database and sync via event
  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null,
        ollamaEndpoint: config.ollamaEndpoint ?? null,
      });

      // Emit event so ConfigContext and other listeners stay in sync
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      toast.success('Model settings saved successfully');
    } catch (error) {
      console.error('Failed to save model config:', error);
      toast.error('Failed to save model settings');
    }
  };

  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig: modelConfig,
    isModelConfigLoading: false, // ConfigContext loads on mount
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle,
    setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: handleOpenModelSettings,
  });

  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
    aiSummary: meetingData.aiSummary,
    blockNoteSummaryRef: meetingData.blockNoteSummaryRef,
  });

  const meetingOperations = useMeetingOperations({
    meeting,
  });

  // Track page view
  useEffect(() => {
    Analytics.trackPageView('meeting_details');
  }, []);

  // F022: Check diarization availability and existing results
  useEffect(() => {
    getDiarizationHealth().then(h => setDiarAvailable(h.available)).catch(() => {});

    // Check if diarization already ran for this meeting
    getDiarizationStatus(meeting.id).then(s => {
      if (s) {
        setDiarStatus(s.status);
        setDiarProgress(s.progress_pct);
        if (s.status === 'completed') {
          // Load result to apply speaker labels
          getDiarizationResult(meeting.id).then(result => {
            applySpeakerLabels(result);
          }).catch(() => {});
        } else if (s.status === 'processing' || s.status === 'pending') {
          startPolling();
        }
      }
    }).catch(() => {});

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [meeting.id]);

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await getDiarizationStatus(meeting.id);
        setDiarStatus(s.status);
        setDiarProgress(s.progress_pct);
        if (s.status === 'completed') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          const result = await getDiarizationResult(meeting.id);
          applySpeakerLabels(result);
          toast.success(`Speaker diarization complete: ${s.num_speakers} speakers found`);
        } else if (s.status === 'failed') {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          toast.error(`Diarization failed: ${s.error || 'Unknown error'}`);
        }
      } catch {
        // Polling error, ignore
      }
    }, 2000);
  };

  const applySpeakerLabels = (result: Awaited<ReturnType<typeof getDiarizationResult>>) => {
    if (!result) return;
    const labels = [...new Set(result.aligned_segments.map(s => s.speaker_label))].filter(l => l !== 'UNKNOWN');
    setDiarSpeakerLabels(labels);
    setDiarSpeakerNames(result.speaker_names || {});

    // Build sample quotes for naming modal
    const quotes: Record<string, string> = {};
    for (const seg of result.aligned_segments) {
      if (seg.text && seg.speaker_label && !quotes[seg.speaker_label]) {
        quotes[seg.speaker_label] = seg.text.slice(0, 80);
      }
    }
    setDiarSampleQuotes(quotes);

    // Apply speaker labels to segments (merge by audio_start_time)
    if (segments) {
      const labelMap = new Map(
        result.aligned_segments.map(s => [s.audio_start_time, s.speaker_display_name || formatSpeakerLabel(s.speaker_label, result.speaker_names?.[s.speaker_label])])
      );
      for (const seg of segments) {
        const label = labelMap.get(seg.timestamp);
        if (label) seg.speaker_label = label;
      }
    }
  };

  const handleStartDiarization = async () => {
    if (!meeting.folder_path) {
      toast.error('No audio file found for this meeting');
      return;
    }
    try {
      const audioPath = `${meeting.folder_path}/audio.mp4`;
      await startDiarization(meeting.id, audioPath);
      setDiarStatus('pending');
      setDiarProgress(0);
      toast.info('Speaker diarization started...');
      startPolling();
    } catch (err) {
      toast.error(`Failed to start diarization: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Auto-generate summary when flag is set
  useEffect(() => {
    let cancelled = false;

    const autoGenerate = async () => {
      if (shouldAutoGenerate && meetingData.transcripts.length > 0 && !cancelled) {
        console.log(`🤖 Auto-generating summary with ${modelConfig.provider}/${modelConfig.model}...`);
        await summaryGeneration.handleGenerateSummary('');

        // Notify parent that auto-generation is complete (only if not cancelled)
        if (onAutoGenerateComplete && !cancelled) {
          onAutoGenerateComplete();
        }
      }
    };

    autoGenerate();

    // Cleanup: cancel if component unmounts or meeting changes
    return () => {
      cancelled = true;
    };
  }, [shouldAutoGenerate, meeting.id]); // Re-run if meeting changes

  // Does this meeting have a saved whiteboard? (controls the "Whiteboard" button visibility)
  const [hasWhiteboard, setHasWhiteboard] = useState(false);
  useEffect(() => {
    const folder = meeting.folder_path;
    if (!folder) { setHasWhiteboard(false); return; }
    const sep = folder.includes('\\') ? '\\' : '/';
    invoke<string | null>('read_file_if_exists', { path: `${folder}${sep}whiteboard.tldr.json` })
      .then((raw) => setHasWhiteboard(!!raw))
      .catch(() => setHasWhiteboard(false));
  }, [meeting.folder_path]);

  const openSavedWhiteboard = () => {
    if (!isPanelOpen) {
      openPanel(meeting.id, meetingData.meetingTitle || meeting.title || 'Meeting', meeting.folder_path || '');
    }
    window.dispatchEvent(
      new CustomEvent('tandem:canvas-open-saved', { detail: { folderPath: meeting.folder_path } }),
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col h-screen bg-background"
    >
      <FiledUnderRow
        meetingId={meeting.id}
        meetingTitle={meetingData.meetingTitle || meeting.title || 'Meeting'}
        folderPath={meeting.folder_path}
        onRelocated={() => { if (onMeetingUpdated) void onMeetingUpdated(); }}
      />
      {/* Enhance-my-notes: renders only when this meeting has jots / enhanced notes. */}
      <MeetingNotesSection
        meetingId={meeting.id}
        folderPath={meeting.folder_path}
        provider={modelConfig.provider}
        model={modelConfig.model}
        apiKey={modelConfig.apiKey ?? null}
        serverAddress={serverAddress}
      />
      <div className="flex flex-1 overflow-hidden">
        <TranscriptPanel
          transcripts={meetingData.transcripts}
          customPrompt={customPrompt}
          onPromptChange={setCustomPrompt}
          onCopyTranscript={copyOperations.handleCopyTranscript}
          onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
          isRecording={isRecording}
          disableAutoScroll={true}
          // Pagination props for efficient loading
          usePagination={true}
          segments={segments}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          screenshots={screenshots}
          clipboardItems={clipboardItems}
        />
        <SummaryPanel
          meeting={meeting}
          meetingTitle={meetingData.meetingTitle}
          onTitleChange={meetingData.handleTitleChange}
          isEditingTitle={meetingData.isEditingTitle}
          onStartEditTitle={() => meetingData.setIsEditingTitle(true)}
          onFinishEditTitle={() => {
            meetingData.setIsEditingTitle(false);
            if (meetingData.isTitleDirty) {
              meetingData.handleSaveMeetingTitle();
            }
          }}
          isTitleDirty={meetingData.isTitleDirty}
          summaryRef={meetingData.blockNoteSummaryRef}
          isSaving={meetingData.isSaving}
          onSaveAll={meetingData.saveAllChanges}
          onCopySummary={copyOperations.handleCopySummary}
          onOpenFolder={meetingOperations.handleOpenMeetingFolder}
          aiSummary={meetingData.aiSummary}
          summaryStatus={summaryGeneration.summaryStatus}
          transcripts={meetingData.transcripts}
          modelConfig={modelConfig}
          setModelConfig={setModelConfig}
          onSaveModelConfig={handleSaveModelConfig}
          onGenerateSummary={summaryGeneration.handleGenerateSummary}
          onStopGeneration={summaryGeneration.handleStopGeneration}
          customPrompt={customPrompt}
          summaryResponse={summaryResponse}
          onSaveSummary={meetingData.handleSaveSummary}
          onSummaryChange={meetingData.handleSummaryChange}
          onDirtyChange={meetingData.setIsSummaryDirty}
          summaryError={summaryGeneration.summaryError}
          onRegenerateSummary={summaryGeneration.handleRegenerateSummary}
          getSummaryStatusMessage={summaryGeneration.getSummaryStatusMessage}
          availableTemplates={templates.availableTemplates}
          selectedTemplate={templates.selectedTemplate}
          onTemplateSelect={templates.handleTemplateSelection}
          isModelConfigLoading={false}
          onOpenModelSettings={handleRegisterModalOpen}
        />

        {/* AI Assistant toggle button */}
        {!isPanelOpen && (
          <button
            onClick={() => {
              openPanel(
                meeting.id,
                meetingData.meetingTitle || meeting.title || 'Meeting',
                meeting.folder_path || '',
              );
            }}
            className="fixed right-4 top-4 z-30 bg-card border border-border rounded-full p-2 shadow-md hover:shadow-lg hover:bg-muted transition-all"
            title="Open AI Assistant"
          >
            <Bot className="w-5 h-5 text-muted-foreground" />
          </button>
        )}

        {/* Whiteboard button — only when this meeting has a saved board */}
        {!isPanelOpen && hasWhiteboard && (
          <button
            onClick={openSavedWhiteboard}
            className="fixed right-16 top-4 z-30 bg-card border border-border rounded-full p-2 shadow-md hover:shadow-lg hover:bg-muted transition-all"
            title="Open whiteboard"
          >
            <PenTool className="w-5 h-5 text-muted-foreground" />
          </button>
        )}

        {/* F022: Identify Speakers button */}
        {diarAvailable && (
          <div className="fixed right-4 top-14 z-30 flex flex-col items-end gap-1">
            {diarStatus === 'completed' ? (
              <button
                onClick={() => setShowNamingModal(true)}
                className="bg-card border border-border rounded-full p-2 shadow-md hover:shadow-lg hover:bg-muted transition-all"
                title="Rename Speakers"
              >
                <Users className="w-5 h-5 text-green-600 dark:text-green-400" />
              </button>
            ) : diarStatus === 'processing' || diarStatus === 'pending' ? (
              <div className="bg-card border border-border rounded-full p-2 shadow-md" title={`Diarizing... ${diarProgress}%`}>
                <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
              </div>
            ) : (
              <button
                onClick={handleStartDiarization}
                className="bg-card border border-border rounded-full p-2 shadow-md hover:shadow-lg hover:bg-muted transition-all"
                title="Identify Speakers"
              >
                <Users className="w-5 h-5 text-muted-foreground" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* F022: Speaker naming modal */}
      <SpeakerNamingModal
        open={showNamingModal}
        onClose={() => setShowNamingModal(false)}
        meetingId={meeting.id}
        speakerLabels={diarSpeakerLabels}
        sampleQuotes={diarSampleQuotes}
        initialNames={diarSpeakerNames}
        onSave={(names) => {
          setDiarSpeakerNames(names);
          // Re-apply labels with new display names
          getDiarizationResult(meeting.id).then(result => {
            if (result) {
              result.speaker_names = names;
              applySpeakerLabels(result);
            }
          }).catch(() => {});
        }}
      />
    </motion.div>
  );
}
