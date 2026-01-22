
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { VoiceName, TextChunk, AppState } from './types';
import { splitTextIntoChunks, cleanTextForTTS } from './utils/fileProcessor';
import { generateTTS, restructureTextWithAI } from './services/geminiService';
import VoiceSelector from './components/VoiceSelector';

const STORAGE_KEY = 'tts_reader_state_v17';
const MAX_CHARS_PER_CHUNK = 3000; 
const ITEMS_PER_PAGE = 10; 

interface ExtendedAppState extends AppState {
  currentPage: number;
  playbackRate: number;
  isAutoNext: boolean;
}

// 상세 상태 관리를 위한 타입 확장
type ChunkStatus = 'pending' | 'analyzing' | 'generating' | 'ready' | 'error';

const App: React.FC = () => {
  const [state, setState] = useState<ExtendedAppState>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const sanitizedChunks = parsed.chunks.map((c: any) => ({
          ...c,
          status: 'pending',
          audioUrl: undefined,
          progress: c.progress || 0
        }));
        return { 
          ...parsed, 
          chunks: sanitizedChunks,
          currentPage: parsed.currentPage || 1,
          playbackRate: parsed.playbackRate || 1.15,
          isAutoNext: parsed.isAutoNext || false
        };
      } catch (e) {
        console.error("Failed to parse state", e);
      }
    }
    return {
      originalFileName: null,
      chunks: [],
      selectedVoice: VoiceName.Puck, 
      currentPage: 1,
      playbackRate: 1.15,
      isAutoNext: false
    };
  });

  const [isLoading, setIsLoading] = useState(false);
  const [isAutoGenerating, setIsAutoGenerating] = useState(false);
  const [viewingChunk, setViewingChunk] = useState<TextChunk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
  const [showResumeBanner, setShowResumeBanner] = useState(false);
  const [fullText, setFullText] = useState<string>('');
  
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPaused, setIsPaused] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (state.lastPlayedChunkId && state.originalFileName) {
      setShowResumeBanner(true);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...state,
      chunks: state.chunks.map(c => ({ ...c, audioUrl: undefined, status: 'pending' }))
    }));
  }, [state]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const handleTimeUpdate = () => {
      if (!activeChunkId) return;
      setCurrentTime(audio.currentTime);
      const progress = (audio.currentTime / audio.duration) * 100;
      
      setState(prev => ({
        ...prev,
        lastPlayedChunkId: activeChunkId,
        lastPlayedTime: audio.currentTime,
        chunks: prev.chunks.map(c => c.id === activeChunkId ? { ...c, progress } : c)
      }));
    };

    const handlePlayPause = () => {
      setIsPaused(audio.paused);
    };

    const handleEnded = async () => {
      if (!state.isAutoNext) {
        setActiveChunkId(null);
        setIsPaused(true);
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 1500)); // 문맥 전환을 위해 조금 더 길게 휴식

      const currentIndex = state.chunks.findIndex(c => c.id === activeChunkId);
      const nextChunk = state.chunks[currentIndex + 1];
      
      if (nextChunk) {
        if (nextChunk.status === 'ready' && nextChunk.audioUrl) {
          handlePlay(nextChunk.audioUrl, nextChunk.id);
        } else {
          setActiveChunkId(null); 
          const success = await handleGenerateTTS(nextChunk.id, true);
          if (!success) {
            setActiveChunkId(null);
            setIsPaused(true);
          }
        }
      } else {
        setActiveChunkId(null);
        setIsPaused(true);
      }
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlayPause);
    audio.addEventListener('pause', handlePlayPause);
    audio.addEventListener('ended', handleEnded);
    
    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlayPause);
      audio.removeEventListener('pause', handlePlayPause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [activeChunkId, state.chunks, state.isAutoNext]);

  const readTextFile = async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(buffer);
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    try { return utf8Decoder.decode(uint8); }
    catch (e) { return new TextDecoder('euc-kr').decode(uint8); }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsLoading(true);
    setError(null);
    try {
      const text = await readTextFile(file);
      if (!text.trim()) throw new Error("파일이 비어있습니다.");
      setFullText(text);
      const textChunks = splitTextIntoChunks(text, MAX_CHARS_PER_CHUNK);
      const newChunks: TextChunk[] = textChunks.map((content, index) => ({
        id: crypto.randomUUID(),
        content,
        status: 'pending',
        fileName: file.name,
        index,
        progress: 0
      }));
      setState(prev => ({ ...prev, originalFileName: file.name, chunks: newChunks, currentPage: 1, lastPlayedChunkId: undefined, lastPlayedTime: 0 }));
      setShowResumeBanner(false);
    } catch (err: any) { setError(err.message); }
    finally { setIsLoading(false); event.target.value = ''; }
  };

  const handleGenerateTTS = async (chunkId: string, autoPlayAfter = false) => {
    const chunk = state.chunks.find(c => c.id === chunkId);
    if (!chunk || chunk.status === 'ready') {
      if (autoPlayAfter && chunk?.audioUrl) handlePlay(chunk.audioUrl, chunkId);
      return true;
    }

    try {
      // 1단계: AI 문맥 분석 및 구조화
      setState(prev => ({ 
        ...prev, 
        chunks: prev.chunks.map(c => c.id === chunkId ? { ...c, status: 'analyzing' } : c) 
      }));
      const restructuredContent = await restructureTextWithAI(chunk.content);
      
      // 2단계: 구조화된 텍스트로 음성 생성
      setState(prev => ({ 
        ...prev, 
        chunks: prev.chunks.map(c => c.id === chunkId ? { ...c, content: restructuredContent, status: 'generating' } : c) 
      }));
      const result = await generateTTS(restructuredContent, state.selectedVoice);
      
      setState(prev => ({ 
        ...prev, 
        chunks: prev.chunks.map(c => c.id === chunkId ? { ...c, status: 'ready', audioUrl: result.url } : c) 
      }));

      if (autoPlayAfter) handlePlay(result.url, chunkId);
      return true;
    } catch (err: any) {
      console.error("TTS Generation Error:", err);
      setState(prev => ({ ...prev, chunks: prev.chunks.map(c => c.id === chunkId ? { ...c, status: 'error' } : c) }));
      return false;
    }
  };

  const handlePlay = (url: string, id: string, startTime: number = 0) => {
    if (audioRef.current) {
      if (activeChunkId === id) {
        if (audioRef.current.paused) audioRef.current.play();
        else audioRef.current.pause();
        return;
      }

      setActiveChunkId(id);
      audioRef.current.src = url;
      audioRef.current.playbackRate = state.playbackRate;
      audioRef.current.currentTime = startTime;
      audioRef.current.play().catch(() => setError("재생 실패"));
      
      const index = state.chunks.findIndex(c => c.id === id);
      const page = Math.floor(index / ITEMS_PER_PAGE) + 1;
      if (page !== state.currentPage) {
        setState(prev => ({ ...prev, currentPage: page }));
      }
    }
  };

  const toggleGlobalPlay = () => {
    if (audioRef.current) {
      if (audioRef.current.paused) audioRef.current.play();
      else audioRef.current.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleResume = async () => {
    const id = state.lastPlayedChunkId;
    if (!id) return;
    setShowResumeBanner(false);
    await handleGenerateTTS(id, true);
    if (audioRef.current && state.lastPlayedTime) {
      audioRef.current.currentTime = state.lastPlayedTime;
    }
  };

  const totalPages = Math.ceil(state.chunks.length / ITEMS_PER_PAGE);
  const currentItems = useMemo(() => {
    const start = (state.currentPage - 1) * ITEMS_PER_PAGE;
    return state.chunks.slice(start, start + ITEMS_PER_PAGE);
  }, [state.chunks, state.currentPage]);

  const activeChunk = useMemo(() => {
    return state.chunks.find(c => c.id === activeChunkId);
  }, [state.chunks, activeChunkId]);

  const overallProgress = useMemo(() => {
    if (state.chunks.length === 0) return 0;
    const total = state.chunks.reduce((acc, c) => acc + (c.progress || 0), 0);
    return Math.round(total / state.chunks.length);
  }, [state.chunks]);

  const handleGenerateAllOnPage = async () => {
    if (isAutoGenerating) return;
    setIsAutoGenerating(true);
    for (const chunk of currentItems) {
      if (chunk.status !== 'ready') {
        const success = await handleGenerateTTS(chunk.id);
        if (!success) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    setIsAutoGenerating(false);
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleDownload = (chunk: TextChunk) => {
    if (!chunk.audioUrl) return;
    const link = document.createElement('a');
    link.href = chunk.audioUrl;
    link.download = `${chunk.fileName}_S${chunk.index + 1}.mp3`; 
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadFile = (content: string, fileName: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownloadText = (chunk: TextChunk) => {
    downloadFile(chunk.content, `${chunk.fileName}_Section_${chunk.index + 1}.txt`, 'text/plain');
  };

  const handleDownloadOriginal = () => {
    if (!fullText) return;
    downloadFile(fullText, state.originalFileName || 'original.txt', 'text/plain');
  };

  const handleDownloadAvailable = () => {
    const readyChunks = state.chunks.filter(c => c.status === 'ready' && c.audioUrl);
    if (readyChunks.length === 0) {
      alert("생성 완료된 음성 파일이 없습니다.");
      return;
    }
    readyChunks.forEach((chunk, i) => {
      setTimeout(() => handleDownload(chunk), i * 300);
    });
  };

  const resetAll = () => {
    if (confirm("초기화할까요?")) {
      setState({ originalFileName: null, chunks: [], selectedVoice: VoiceName.Puck, currentPage: 1, playbackRate: 1.15, isAutoNext: false });
      localStorage.removeItem(STORAGE_KEY);
      setActiveChunkId(null);
      setShowResumeBanner(false);
      setFullText('');
    }
  };

  return (
    <div className="max-w-md mx-auto min-h-screen bg-slate-50 flex flex-col shadow-2xl relative border-x border-slate-200">
      <header className="sticky top-0 z-20 glass-card p-4 border-b border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-black text-indigo-600 flex items-center gap-2 tracking-tight">
            <i className="fa-solid fa-bolt-lightning text-amber-400"></i>
            TTS FAST
          </h1>
          <div className="flex items-center gap-2">
            {state.originalFileName && (
              <div className="flex flex-col items-end mr-2">
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Progress</span>
                <span className="text-xs font-black text-indigo-600">{overallProgress}%</span>
              </div>
            )}
            {state.originalFileName && (
              <button onClick={resetAll} className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:text-red-500 transition-all">
                <i className="fa-solid fa-trash-can text-xs"></i>
              </button>
            )}
          </div>
        </div>
        
        <div className="flex flex-col gap-3">
          <VoiceSelector selectedVoice={state.selectedVoice} onVoiceChange={(voice) => setState(prev => ({ ...prev, selectedVoice: voice }))} />
          
          <div className="flex items-center justify-between bg-white/50 p-2 rounded-xl border border-slate-100">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider ml-1">Speed</span>
            <div className="flex gap-1 overflow-x-auto no-scrollbar">
              {[0.8, 1.0, 1.15, 1.25, 1.5].map((rate) => (
                <button
                  key={rate}
                  onClick={() => {
                    if (audioRef.current) audioRef.current.playbackRate = rate;
                    setState(prev => ({ ...prev, playbackRate: rate }));
                  }}
                  className={`px-2 py-1 rounded-lg text-[10px] font-black transition-all flex-shrink-0 ${
                    state.playbackRate === rate ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:bg-slate-100'
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        {showResumeBanner && state.originalFileName && (
          <div className="mx-4 mt-4 p-4 bg-indigo-600 rounded-2xl text-white shadow-xl flex items-center justify-between">
            <div className="flex-1">
              <p className="text-[10px] font-bold opacity-80 uppercase mb-0.5">Welcome back!</p>
              <p className="text-xs font-bold truncate pr-4">계속해서 읽으시겠습니까?</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowResumeBanner(false)} className="text-[10px] font-black px-3 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-400">취소</button>
              <button onClick={handleResume} className="text-[10px] font-black px-4 py-2 rounded-xl bg-white text-indigo-600 shadow-lg active:scale-95">이어듣기</button>
            </div>
          </div>
        )}

        {!state.originalFileName ? (
          <div className="p-8 mt-12 text-center">
            <div className="bg-white p-10 rounded-[2.5rem] shadow-xl border border-slate-100">
              <div className="w-20 h-20 bg-indigo-50 text-indigo-600 rounded-[2rem] flex items-center justify-center mx-auto mb-8 text-3xl shadow-inner">
                <i className="fa-solid fa-file-word"></i>
              </div>
              <h2 className="text-xl font-black text-slate-800 mb-3">대용량 텍스트 읽기</h2>
              <p className="text-sm text-slate-500 mb-10 leading-relaxed font-medium">
                파일을 3,000자 단위로 쪼개어<br/>AI가 자연스럽게 다듬어 읽어줍니다.
              </p>
              <label className="bg-slate-900 hover:bg-black text-white px-10 py-4 rounded-2xl font-bold transition-all cursor-pointer inline-flex items-center gap-3 shadow-2xl active:scale-95">
                파일 선택하기
                <input type="file" accept=".txt" onChange={handleFileUpload} className="hidden" />
              </label>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col p-4 pb-32">
            <div className="flex flex-col gap-2 mb-6">
              <div className="bg-indigo-600 p-5 rounded-3xl shadow-lg shadow-indigo-100 text-white flex flex-col gap-4 relative overflow-hidden">
                <div className="flex items-center justify-between relative z-10">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-bold opacity-70 uppercase tracking-widest mb-1">Current File</p>
                    <p className="text-sm font-bold truncate leading-tight">{state.originalFileName}</p>
                  </div>
                  <div className="text-right ml-4">
                    <p className="text-[10px] font-bold opacity-70 uppercase tracking-widest mb-1">Sections</p>
                    <p className="text-xl font-black leading-none">{state.chunks.length}</p>
                  </div>
                </div>
                
                <div className="flex gap-2 relative z-10">
                  <button 
                    onClick={handleDownloadAvailable}
                    className="flex-1 bg-white/20 hover:bg-white/30 backdrop-blur-md text-white py-3 rounded-2xl text-[10px] font-black flex items-center justify-center gap-2 transition-all active:scale-95 border border-white/20"
                  >
                    <i className="fa-solid fa-cloud-arrow-down"></i> 모든 음성
                  </button>
                  <button 
                    onClick={handleDownloadOriginal}
                    className="flex-1 bg-white/20 hover:bg-white/30 backdrop-blur-md text-white py-3 rounded-2xl text-[10px] font-black flex items-center justify-center gap-2 transition-all active:scale-95 border border-white/20"
                  >
                    <i className="fa-solid fa-file-lines"></i> 원본 텍스트
                  </button>
                </div>
              </div>

              <div className="flex gap-2">
                <button 
                  onClick={handleGenerateAllOnPage}
                  disabled={isAutoGenerating}
                  className={`flex-[2] py-4 rounded-2xl font-black text-xs flex items-center justify-center gap-2 transition-all shadow-sm border-2 ${
                    isAutoGenerating ? 'bg-slate-200 text-slate-400 border-slate-200' : 'bg-white border-indigo-600 text-indigo-600 hover:bg-indigo-50'
                  }`}
                >
                  {isAutoGenerating ? (
                     <><div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>처리 중...</>
                  ) : (
                    <><i className="fa-solid fa-wand-magic-sparkles"></i>현재 페이지 모든 음성 생성</>
                  )}
                </button>
                
                <button 
                  onClick={() => setState(prev => ({ ...prev, isAutoNext: !prev.isAutoNext }))}
                  className={`flex-1 py-4 rounded-2xl font-black text-xs flex items-center justify-center gap-2 transition-all shadow-sm border-2 ${
                    state.isAutoNext ? 'bg-indigo-600 border-indigo-600 text-white shadow-indigo-100' : 'bg-white border-slate-200 text-slate-400'
                  }`}
                >
                  <i className={`fa-solid ${state.isAutoNext ? 'fa-forward-step' : 'fa-play'}`}></i>
                  연속 듣기 {state.isAutoNext ? 'ON' : 'OFF'}
                </button>
              </div>
              <p className="text-[10px] text-center font-bold text-slate-400 mt-1 uppercase tracking-widest">
                <i className="fa-solid fa-microchip text-indigo-400 mr-1"></i> AI Contextual Breathing & Paragraphing
              </p>
            </div>

            <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden divide-y divide-slate-50">
              {currentItems.map((chunk) => (
                <div key={chunk.id} className={`p-4 transition-all relative ${activeChunkId === chunk.id ? 'bg-indigo-50/50' : 'hover:bg-slate-50'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <span className={`text-[10px] font-black w-6 ${activeChunkId === chunk.id ? 'text-indigo-600' : 'text-slate-300'}`}>
                        {String(chunk.index + 1).padStart(2, '0')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-bold ${activeChunkId === chunk.id ? 'text-indigo-600' : 'text-slate-700'}`}>
                          섹션 {chunk.index + 1}
                        </div>
                        <div className="text-[10px] text-slate-400 font-medium">
                          {chunk.content.length.toLocaleString()} 자 · {Math.round(chunk.progress || 0)}%
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <button onClick={() => setViewingChunk(chunk)} className="w-8 h-8 rounded-lg bg-slate-50 text-slate-400 hover:text-indigo-600 flex items-center justify-center" title="원문 보기">
                        <i className="fa-solid fa-eye text-[10px]"></i>
                      </button>
                      <button onClick={() => handleDownloadText(chunk)} className="w-8 h-8 rounded-lg bg-slate-50 text-slate-400 hover:text-indigo-600 flex items-center justify-center" title="섹션 텍스트 다운로드">
                        <i className="fa-solid fa-file-lines text-[10px]"></i>
                      </button>
                      
                      {chunk.status === 'pending' && (
                        <button onClick={() => handleGenerateTTS(chunk.id)} className="bg-slate-900 text-white w-12 h-8 rounded-lg text-[10px] font-black hover:bg-black transition-all">생성</button>
                      )}
                      
                      {chunk.status === 'analyzing' && (
                        <div className="w-12 h-8 flex items-center justify-center gap-1">
                           <div className="w-1 h-1 bg-indigo-500 rounded-full animate-bounce"></div>
                           <div className="w-1 h-1 bg-indigo-500 rounded-full animate-bounce delay-100"></div>
                           <div className="w-1 h-1 bg-indigo-500 rounded-full animate-bounce delay-200"></div>
                        </div>
                      )}
                      
                      {chunk.status === 'generating' && (
                        <div className="w-12 h-8 flex items-center justify-center"><div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div></div>
                      )}
                      
                      {chunk.status === 'ready' && (
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={() => chunk.audioUrl && handlePlay(chunk.audioUrl, chunk.id)} 
                            className={`w-8 h-8 rounded-lg text-[10px] flex items-center justify-center transition-all ${activeChunkId === chunk.id ? 'bg-indigo-600 text-white shadow-md' : 'bg-indigo-50 text-indigo-600'}`}
                            title="재생"
                          >
                            <i className={`fa-solid ${activeChunkId === chunk.id && !isPaused ? 'fa-pause' : 'fa-play'}`}></i>
                          </button>
                          <button 
                            onClick={() => handleDownload(chunk)} 
                            className="w-8 h-8 rounded-lg bg-slate-100 text-slate-400 hover:text-indigo-600 flex items-center justify-center"
                            title="음성 다운로드"
                          >
                            <i className="fa-solid fa-download text-[10px]"></i>
                          </button>
                        </div>
                      )}
                      
                      {chunk.status === 'error' && (
                        <button onClick={() => handleGenerateTTS(chunk.id)} className="bg-red-50 text-red-500 w-12 h-8 rounded-lg text-[10px] font-black">재시도</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-8 mb-8 flex items-center justify-center gap-2">
                <button onClick={() => setState(prev => ({ ...prev, currentPage: Math.max(1, prev.currentPage - 1) }))} disabled={state.currentPage === 1} className="w-10 h-10 rounded-xl bg-white border border-slate-200 text-slate-400 disabled:opacity-30 flex items-center justify-center active:scale-90 transition-all"><i className="fa-solid fa-angle-left text-xs"></i></button>
                <div className="bg-white px-4 py-2 rounded-xl border border-slate-200 shadow-sm flex items-center gap-2">
                  <span className="text-[10px] font-black text-indigo-600">{state.currentPage} / {totalPages}</span>
                </div>
                <button onClick={() => setState(prev => ({ ...prev, currentPage: Math.min(totalPages, prev.currentPage + 1) }))} disabled={state.currentPage === totalPages} className="w-10 h-10 rounded-xl bg-white border border-slate-200 text-slate-400 disabled:opacity-30 flex items-center justify-center active:scale-90 transition-all"><i className="fa-solid fa-angle-right text-xs"></i></button>
              </div>
            )}
          </div>
        )}

        {activeChunkId && activeChunk && (
          <div className="fixed bottom-0 left-0 right-0 z-40 p-4 max-w-md mx-auto">
            <div className="glass-card bg-indigo-900/90 text-white p-4 rounded-[2rem] shadow-2xl border border-indigo-700/50 animate-in slide-in-from-bottom-10">
              <div className="flex items-center gap-4 mb-3">
                <button 
                  onClick={toggleGlobalPlay}
                  className="w-12 h-12 bg-white text-indigo-600 rounded-full flex items-center justify-center shadow-lg active:scale-95 transition-all"
                >
                  <i className={`fa-solid ${isPaused ? 'fa-play ml-1' : 'fa-pause'}`}></i>
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold opacity-70 uppercase tracking-widest leading-none mb-1">Now Playing</p>
                  <p className="text-sm font-bold truncate">Section {activeChunk.index + 1}</p>
                </div>
                <div className="text-[10px] font-black opacity-70">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </div>
              </div>
              
              <div className="flex flex-col gap-1">
                <input 
                  type="range"
                  min="0"
                  max={duration || 0}
                  step="0.01"
                  value={currentTime}
                  onChange={handleSeek}
                  className="w-full h-1.5 bg-indigo-700 rounded-lg appearance-none cursor-pointer accent-white"
                />
              </div>
            </div>
          </div>
        )}

        {viewingChunk && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
            <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl overflow-hidden animate-in slide-in-from-bottom-10 flex flex-col">
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <div>
                  <h3 className="text-lg font-black text-slate-800">섹션 {viewingChunk.index + 1} 원문</h3>
                  <p className="text-[10px] font-bold text-slate-400 tracking-wider">
                    {viewingChunk.status === 'ready' ? 'AI에 의해 가독성이 개선된 텍스트입니다.' : '원본 텍스트입니다.'}
                  </p>
                </div>
                <button onClick={() => setViewingChunk(null)} className="w-10 h-10 rounded-full bg-white shadow-sm border border-slate-100 text-slate-400 flex items-center justify-center hover:bg-red-50 hover:text-red-500 transition-all"><i className="fa-solid fa-xmark"></i></button>
              </div>
              
              <div className="p-8 max-h-[50vh] overflow-y-auto font-medium text-slate-700 text-sm leading-relaxed whitespace-pre-wrap flex-1">{viewingChunk.content}</div>
              
              <div className="p-6 bg-slate-50 border-t border-slate-100 flex gap-2">
                <button 
                  onClick={() => handleDownloadText(viewingChunk)}
                  className="flex-1 py-4 bg-white border-2 border-slate-200 text-slate-700 rounded-2xl font-black text-xs flex items-center justify-center gap-2"
                >
                  <i className="fa-solid fa-file-lines"></i> 텍스트 저장
                </button>
                {viewingChunk.status === 'ready' && (
                   <button 
                    onClick={() => handleDownload(viewingChunk)}
                    className="flex-1 py-4 bg-indigo-600 text-white rounded-2xl font-black text-xs shadow-lg flex items-center justify-center gap-2"
                   >
                     <i className="fa-solid fa-download"></i> 음성 저장
                   </button>
                )}
                <button onClick={() => setViewingChunk(null)} className="flex-1 py-4 bg-slate-900 text-white rounded-2xl font-black text-xs">닫기</button>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="p-5 text-center border-t border-slate-100 bg-white/90">
        <p className="text-[9px] text-slate-400 font-black uppercase tracking-[0.2em]">Intelligent AI Restructure Active</p>
      </footer>
      <audio ref={audioRef} className="hidden" />
    </div>
  );
};

export default App;
