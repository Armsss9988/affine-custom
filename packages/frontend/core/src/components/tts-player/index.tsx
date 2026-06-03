import { useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { ttsAtom } from './state';

export function TTSPlayer() {
  const [state, setState] = useAtom(ttsAtom);
  const [voices, setVoices] = useState<Array<{ name: string; ssmlGender: string; languageCodes: string[] }>>([]);

  const { isOpen, isPlaying, isLoading, voice, rate, progress, error } = state;

  // 1. Fetch available voices from backend on mount
  useEffect(() => {
    fetch('/chatbot/api/tts/voices')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch voices');
        return res.json();
      })
      .then((data) => {
        if (data.voices) {
          // Filter to Vietnamese and English
          const filtered = data.voices.filter((v: any) =>
            v.languageCodes.some((code: string) => code.startsWith('vi') || code.startsWith('en'))
          );
          setVoices(filtered);
        }
      })
      .catch((err) => {
        console.error('[TTS] Failed to fetch voices:', err);
        // Fallback voices
        setVoices([
          { name: 'vi-VN-Neural2-A', ssmlGender: 'FEMALE', languageCodes: ['vi-VN'] },
          { name: 'vi-VN-Neural2-D', ssmlGender: 'MALE', languageCodes: ['vi-VN'] },
          { name: 'en-US-Journey-F', ssmlGender: 'FEMALE', languageCodes: ['en-US'] },
          { name: 'en-US-Journey-D', ssmlGender: 'MALE', languageCodes: ['en-US'] },
        ]);
      });
  }, []);

  // Register global callback for BlockSuite integration
  useEffect(() => {
    (window as any).readTextWithTTS = (text: string) => {
      ttsController.synthesizeAndPlay(
        text,
        state.voice,
        state.rate,
        setState
      );
    };
    return () => {
      delete (window as any).readTextWithTTS;
    };
  }, [state.voice, state.rate, setState]);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      if (ttsController.audio) {
        ttsController.audio.pause();
        ttsController.audio.src = '';
        ttsController.audio = null;
      }
      if (ttsController.activeUrl) {
        URL.revokeObjectURL(ttsController.activeUrl);
        ttsController.activeUrl = null;
      }
    };
  }, []);

  // Handle Play/Pause
  const handleTogglePlay = () => {
    if (!ttsController.audio) return;
    if (isPlaying) {
      ttsController.audio.pause();
      setState((prev) => ({ ...prev, isPlaying: false }));
    } else {
      ttsController.audio.play().then(() => {
        setState((prev) => ({ ...prev, isPlaying: true }));
      }).catch(err => {
        console.error('[TTS] Play failed:', err);
      });
    }
  };

  // Handle Stop
  const handleStop = () => {
    if (ttsController.audio) {
      ttsController.audio.pause();
      ttsController.audio.currentTime = 0;
    }
    setState((prev) => ({ ...prev, isPlaying: false, progress: 0 }));
  };

  // Handle Speed (speakingRate) Change
  const handleRateChange = (newRate: number) => {
    setState((prev) => ({ ...prev, rate: newRate }));
    if (ttsController.audio) {
      ttsController.audio.playbackRate = newRate;
    }
  };

  // Handle Voice Change (requires resynthesis)
  const handleVoiceChange = (newVoice: string) => {
    setState((prev) => ({ ...prev, voice: newVoice }));
  };

  // Handle Close
  const handleClose = () => {
    handleStop();
    if (ttsController.audio) {
      ttsController.audio.src = '';
      ttsController.audio = null;
    }
    setState((prev) => ({ ...prev, isOpen: false }));
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '80px',
        right: '24px',
        width: '360px',
        backgroundColor: 'rgba(24, 24, 28, 0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderRadius: '12px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.35)',
        padding: '12px 16px',
        zIndex: 9999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#f0f0f5',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      {/* Header Info */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '16px' }}>🔊</span>
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#c4b5fd' }}>
            {isLoading ? 'Đang tạo giọng nói AI...' : 'Google Cloud TTS Player'}
          </span>
        </div>
        <button
          onClick={handleClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#9999aa',
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px',
          }}
          title="Đóng"
        >
          ✕
        </button>
      </div>

      {error && (
        <div style={{ color: '#ef4444', fontSize: '11px', wordBreak: 'break-all' }}>
          ⚠ {error}
        </div>
      )}

      {/* Controls row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {/* Play/Pause Button */}
        <button
          onClick={handleTogglePlay}
          disabled={isLoading}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            backgroundColor: isLoading ? '#4b5563' : '#8a5cf6',
            border: 'none',
            color: 'white',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            boxShadow: '0 4px 12px rgba(139, 92, 246, 0.3)',
          }}
        >
          {isLoading ? '⏳' : isPlaying ? '⏸' : '▶'}
        </button>

        {/* Stop Button */}
        <button
          onClick={handleStop}
          disabled={isLoading}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            color: '#f0f0f5',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
          }}
          title="Dừng"
        >
          ■
        </button>

        {/* Progress Info */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ height: '4px', backgroundColor: 'rgba(255, 255, 255, 0.1)', borderRadius: '2px', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                backgroundColor: '#8a5cf6',
                transition: 'width 0.1s linear',
              }}
            />
          </div>
        </div>
      </div>

      {/* Settings Row */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11px' }}>
        {/* Speed Selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1 }}>
          <label style={{ color: '#9999aa' }}>Tốc độ</label>
          <select
            value={rate}
            onChange={(e) => handleRateChange(parseFloat(e.target.value))}
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '6px',
              color: 'white',
              padding: '4px 6px',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="0.75">0.75x</option>
            <option value="1.0">1.0x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2.0">2.0x</option>
          </select>
        </div>

        {/* Voice Selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 2 }}>
          <label style={{ color: '#9999aa' }}>Giọng đọc AI</label>
          <select
            value={voice}
            onChange={(e) => handleVoiceChange(e.target.value)}
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '6px',
              color: 'white',
              padding: '4px 6px',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {voices.map((v) => {
              const friendlyName = v.name
                .replace('vi-VN-Neural2-A', '🇻🇳 Nữ (Neural2)')
                .replace('vi-VN-Neural2-D', '🇻🇳 Nam (Neural2)')
                .replace('en-US-Journey-F', '🇺🇸 Nữ (Journey)')
                .replace('en-US-Journey-D', '🇺🇸 Nam (Journey)')
                .replace('vi-VN-Wavenet-A', '🇻🇳 Nữ (Wavenet)')
                .replace('vi-VN-Wavenet-B', '🇻🇳 Nam (Wavenet)')
                .replace('en-GB-Neural2-A', '🇬🇧 Nữ (Neural2)')
                .replace('en-GB-Neural2-B', '🇬🇧 Nam (Neural2)');

              return (
                <option key={v.name} value={v.name}>
                  {friendlyName}
                </option>
              );
            })}
          </select>
        </div>
      </div>
    </div>
  );
}

// Global player controller for component interaction
export const ttsController = {
  audio: null as HTMLAudioElement | null,
  activeUrl: null as string | null,
  
  async synthesizeAndPlay(text: string, voiceName: string, speedRate: number, setAtomState: any) {
    if (!text || !text.trim()) return;

    // Reset previous audio
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    if (this.activeUrl) {
      URL.revokeObjectURL(this.activeUrl);
      this.activeUrl = null;
    }

    setAtomState((prev: any) => ({
      ...prev,
      isOpen: true,
      isLoading: true,
      isPlaying: false,
      progress: 0,
      error: null,
    }));

    try {
      const response = await fetch('/chatbot/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: voiceName,
          speakingRate: speedRate,
        }),
      });

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(errorJson.error || `HTTP error ${response.status}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      this.activeUrl = url;

      const audio = new Audio(url);
      audio.playbackRate = speedRate;
      this.audio = audio;

      // Event listeners
      audio.addEventListener('timeupdate', () => {
        if (audio.duration) {
          const progressPercent = (audio.currentTime / audio.duration) * 100;
          setAtomState((prev: any) => ({ ...prev, progress: progressPercent }));
        }
      });

      audio.addEventListener('ended', () => {
        setAtomState((prev: any) => ({ ...prev, isPlaying: false, progress: 100 }));
        if (this.activeUrl) {
          URL.revokeObjectURL(this.activeUrl);
          this.activeUrl = null;
        }
      });

      audio.addEventListener('error', (e) => {
        console.error('[TTS] Audio playback error:', e);
        setAtomState((prev: any) => ({
          ...prev,
          isLoading: false,
          isPlaying: false,
          error: 'Lỗi khi phát âm thanh',
        }));
      });

      await audio.play();
      setAtomState((prev: any) => ({
        ...prev,
        isLoading: false,
        isPlaying: true,
      }));
    } catch (err: any) {
      console.error('[TTS] Synthesis failed:', err);
      setAtomState((prev: any) => ({
        ...prev,
        isLoading: false,
        isPlaying: false,
        error: err.message || 'Không thể tạo giọng nói',
      }));
    }
  }
};
