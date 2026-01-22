
export const cleanTextForTTS = (text: string): string => {
  return text
    // 1. 제어 문자 제거
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
    // 2. 불필요한 장식 기호 제거
    .replace(/[※▶▣◈◆▷■□○●◎◇▽▼▲△◀◁]/g, " ")
    // 3. 최소한의 공백 정규화 (AI가 구조를 잡기 좋게 기본만 유지)
    .replace(/\.([^\s]|$)/g, ". $1")
    .replace(/\?([^\s]|$)/g, "? $1")
    .replace(/!([^\s]|$)/g, "! $1")
    .replace(/,([^\s])/g, ", $1")
    // 4. 연속된 줄바꿈 정리
    .replace(/\n{3,}/g, "\n\n")
    // 5. 너무 긴 중복 부호 정리
    .replace(/!{3,}/g, "!!")
    .replace(/\?{3,}/g, "??")
    .replace(/\.{4,}/g, "...")
    // 6. 인용부호 주변 정리
    .replace(/[""＂„]/g, '"')
    .replace(/[''‘’]/g, "'")
    .trim();
};

export const splitTextIntoChunks = (text: string, maxChars: number = 3000): string[] => {
  const cleanedText = cleanTextForTTS(text);
  const chunks: string[] = [];
  let currentChunk = "";
  
  // 마침표나 줄바꿈을 기준으로 나누어 문맥이 끊기지 않게 함
  const segments = cleanedText.split(/([.\n?!])\s*/);
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    
    if ((currentChunk.length + seg.length) > maxChars) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = seg;
    } else {
      currentChunk += seg;
    }
  }
  
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
};
