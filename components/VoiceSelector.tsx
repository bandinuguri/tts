
import React from 'react';
import { VoiceName } from '../types';

interface VoiceSelectorProps {
  selectedVoice: VoiceName;
  onVoiceChange: (voice: VoiceName) => void;
}

// 각 목소리별 성별 및 특징 매핑
const voiceLabels: Record<VoiceName, string> = {
  [VoiceName.Kore]: 'Kore (여 - 밝음)',
  [VoiceName.Zephyr]: 'Zephyr (여 - 부드러움)',
  [VoiceName.Puck]: 'Puck (남 - 신뢰감)',
  [VoiceName.Charon]: 'Charon (남 - 차분함)',
  [VoiceName.Fenrir]: 'Fenrir (남 - 중저음)',
};

const VoiceSelector: React.FC<VoiceSelectorProps> = ({ selectedVoice, onVoiceChange }) => {
  return (
    <div className="flex items-center gap-3">
      <label htmlFor="voice-select" className="text-[10px] font-black text-slate-400 uppercase tracking-wider ml-1">Voice</label>
      <select
        id="voice-select"
        value={selectedVoice}
        onChange={(e) => onVoiceChange(e.target.value as VoiceName)}
        className="flex-1 bg-white border border-slate-100 rounded-xl px-3 py-2.5 text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all shadow-sm appearance-none"
        style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%2394a3b8\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M19 9l-7 7-7-7\'%3E%3C/path%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.75rem center', backgroundSize: '1rem' }}
      >
        {Object.values(VoiceName).map((voice) => (
          <option key={voice} value={voice}>
            {voiceLabels[voice] || voice}
          </option>
        ))}
      </select>
    </div>
  );
};

export default VoiceSelector;
