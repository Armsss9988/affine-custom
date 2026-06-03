import { atom } from 'jotai';

export interface TTSState {
  isOpen: boolean;
  isPlaying: boolean;
  isLoading: boolean;
  docId: string;
  voice: string;
  rate: number;
  progress: number;
  error: string | null;
}

export const ttsAtom = atom<TTSState>({
  isOpen: false,
  isPlaying: false,
  isLoading: false,
  docId: '',
  voice: 'vi-VN-Neural2-A',
  rate: 1.0,
  progress: 0,
  error: null,
});
