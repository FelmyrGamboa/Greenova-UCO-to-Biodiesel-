import type { ReactNode } from 'react';

interface ConfirmModalProps {
  title: string;
  message: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
      <div className="glass rounded-2xl p-6 w-full max-w-md fade-in-up" style={{ border: '1px solid rgba(34,197,94,0.15)' }}>
        <h3 className="font-display font-bold text-lg text-white mb-2">{title}</h3>
        <div className="text-sm text-gray-400 mb-6">{message}</div>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="btn-ghost text-sm py-2 px-4">
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={danger ? 'btn-danger text-sm py-2 px-4' : 'btn-primary text-sm py-2 px-4'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
