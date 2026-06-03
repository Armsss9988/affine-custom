import { useCallback } from 'react';
import { useAtom } from 'jotai';
import { IconButton } from '@affine/component';
import { ttsAtom } from './state';
import { ttsController } from './index';

interface TTSButtonProps {
  page: any;
}

export const TTSButton = ({ page }: TTSButtonProps) => {
  const [state, setState] = useAtom(ttsAtom);

  const getDocPlainText = (pageObj: any) => {
    const texts: string[] = [];
    const title = pageObj.meta?.title || '';
    if (title) texts.push(title);

    if (pageObj && typeof pageObj.getAllModels === 'function') {
      for (const model of pageObj.getAllModels()) {
        if (model.text && typeof model.text.toString === 'function') {
          const txt = model.text.toString().trim();
          if (txt) {
            texts.push(txt);
          }
        }
      }
    }
    return texts.join('\n\n');
  };

  const handleRead = useCallback(() => {
    const text = getDocPlainText(page);
    if (!text || !text.trim()) {
      alert('Tài liệu không có nội dung để đọc.');
      return;
    }
    ttsController.synthesizeAndPlay(
      text,
      state.voice,
      state.rate,
      setState
    );
  }, [page, state.voice, state.rate, setState]);

  return (
    <IconButton
      size="20"
      tooltip={state.isPlaying ? "Đang phát đọc tài liệu" : "Đọc tài liệu (TTS)"}
      data-testid="header-tts-button"
      onClick={handleRead}
      style={{
        color: state.isPlaying ? '#8a5cf6' : 'inherit',
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill={state.isPlaying ? 'currentColor' : 'none'} />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    </IconButton>
  );
};
