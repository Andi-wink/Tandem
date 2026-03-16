import { Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface StatusOverlaysProps {
  isProcessing: boolean;
  isSaving: boolean;
  sidebarCollapsed: boolean;
}

interface StatusOverlayProps {
  show: boolean;
  message: string;
  sidebarCollapsed: boolean;
}

function StatusOverlay({ show, message, sidebarCollapsed }: StatusOverlayProps) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.2 }}
          className="fixed bottom-4 left-0 right-0 z-10"
        >
          <div
            className="flex justify-center pl-8 transition-[margin] duration-300"
            style={{
              marginLeft: sidebarCollapsed ? '4rem' : '16rem'
            }}
          >
            <div className="w-2/3 max-w-[750px] flex justify-center">
              <div className="bg-card rounded-lg shadow-lg px-4 py-2 flex items-center space-x-2">
                <Loader2 className="h-4 w-4 animate-spin text-foreground" />
                <span className="text-sm text-foreground">{message}</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function StatusOverlays({
  isProcessing,
  isSaving,
  sidebarCollapsed
}: StatusOverlaysProps) {
  return (
    <>
      <StatusOverlay
        show={isProcessing}
        message="Finalizing transcription..."
        sidebarCollapsed={sidebarCollapsed}
      />
      <StatusOverlay
        show={isSaving}
        message="Saving transcript..."
        sidebarCollapsed={sidebarCollapsed}
      />
    </>
  );
}
