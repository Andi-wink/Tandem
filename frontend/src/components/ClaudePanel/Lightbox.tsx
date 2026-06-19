import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface LightboxProps {
  onClose: () => void;
  children: React.ReactNode;
}

export function Lightbox({ onClose, children }: LightboxProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center cursor-zoom-out"
      onClick={onClose}
    >
      {children}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Close lightbox"
      >
        <X className="w-5 h-5" />
      </button>
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/60 text-xs">
        Click outside or press Escape to close
      </div>
    </div>
  );
}
