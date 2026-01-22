
export enum VoiceName {
  Kore = 'Kore',
  Puck = 'Puck',
  Charon = 'Charon',
  Fenrir = 'Fenrir',
  Zephyr = 'Zephyr'
}

export interface TextChunk {
  id: string;
  content: string;
  status: 'pending' | 'generating' | 'ready' | 'error';
  audioUrl?: string;
  fileName: string;
  index: number;
  progress?: number; // 0 ~ 100 사이의 재생 진행률
}

export interface AppState {
  originalFileName: string | null;
  chunks: TextChunk[];
  selectedVoice: VoiceName;
  lastPlayedChunkId?: string;
  lastPlayedTime?: number;
}
