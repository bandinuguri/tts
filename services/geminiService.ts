
import { GoogleGenAI, Modality } from "@google/genai";
import { VoiceName } from "../types";

// 싱글톤 오디오 컨텍스트
let globalAudioContext: AudioContext | null = null;
const getAudioContext = () => {
  if (!globalAudioContext) {
    globalAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }
  return globalAudioContext;
};

const decode = (base64: string) => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

const decodeAudioData = async (
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> => {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
};

const audioBufferToWav = (buffer: AudioBuffer): Blob => {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const length = buffer.length * blockAlign;
  const bufferArray = new ArrayBuffer(44 + length);
  const view = new DataView(bufferArray);
  
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, length, true);
  
  const offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset + (i * blockAlign) + (channel * bytesPerSample), intSample, true);
    }
  }
  return new Blob([bufferArray], { type: 'audio/wav' });
};

/**
 * 텍스트를 분석하여 자연스러운 단락과 호흡으로 재구성합니다.
 */
export const restructureTextWithAI = async (text: string): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `이 글의 문맥을 분석해서 낭독하기 좋게 단락(Paragraph)을 나누고 자연스러운 줄바꿈을 재구성해줘.
원문의 내용은 한 글자도 빠짐없이 유지해야 하며, 요약하지 마.
오직 재구성된 텍스트만 출력해:\n\n${text}`,
  });
  return response.text || text;
};

export const generateTTS = async (text: string, voiceName: VoiceName): Promise<{ blob: Blob; url: string }> => {
  const sanitizedText = text
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
    .substring(0, 4000); // 구조화된 텍스트는 약간 더 길어질 수 있음

  const textWithInstruction = `차분하고 지적인 호흡으로, 문장 사이의 여운을 충분히 두면서 자연스럽게 읽어주세요:\n\n${sanitizedText}`;

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: textWithInstruction }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("오디오 데이터를 받지 못했습니다.");

  const audioContext = getAudioContext();
  const decodedData = decode(base64Audio);
  const audioBuffer = await decodeAudioData(decodedData, audioContext, 24000, 1);
  
  const wavBlob = audioBufferToWav(audioBuffer);
  const audioUrl = URL.createObjectURL(wavBlob);
  
  return { blob: wavBlob, url: audioUrl };
};
