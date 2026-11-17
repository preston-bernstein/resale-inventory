import type { RefObject } from 'react';
import type { PhoneSessionItem } from './usePhoneSession';
import type { UploadFeedback } from './usePhoneUpload';

function FeedbackMessage({ feedback }: { feedback: UploadFeedback }) {
  return (
    <p
      className={
        feedback.kind === 'success'
          ? 'text-green-700 dark:text-green-400 text-center'
          : 'text-red-600 dark:text-red-400 text-center'
      }
    >
      {feedback.message}
    </p>
  );
}

interface PhoneUploadViewProps {
  item: PhoneSessionItem;
  fileInputRef: RefObject<HTMLInputElement | null>;
  uploading: boolean;
  feedback: UploadFeedback | null;
  onUpload: () => void;
}

export default function PhoneUploadView({
  item,
  fileInputRef,
  uploading,
  feedback,
  onUpload,
}: PhoneUploadViewProps) {
  return (
    <div className="min-h-screen max-w-md mx-auto px-4 py-6 flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{item.title}</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">{item.brand}</p>
        <p className="text-gray-600 dark:text-gray-400">Size {item.size_label}</p>
      </div>

      <div className="flex flex-col gap-3">
        <label
          htmlFor="phone-photo-input"
          className="w-full text-center px-4 py-4 rounded-lg bg-blue-600 text-white text-lg font-medium active:bg-blue-700"
        >
          Take / choose photos
        </label>
        <input
          id="phone-photo-input"
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
        />

        <button
          type="button"
          onClick={onUpload}
          disabled={uploading}
          className="w-full px-4 py-4 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-lg font-medium disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>

        {feedback && <FeedbackMessage feedback={feedback} />}
      </div>
    </div>
  );
}
