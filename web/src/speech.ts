/** English pronunciation via the browser's Web Speech API (speechSynthesis). */

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const prefix = lang.slice(0, 2).toLowerCase();
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
  return (
    matching.find((v) => v.lang.toLowerCase() === lang.toLowerCase() && v.localService) ??
    matching.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
    matching.find((v) => v.localService) ??
    matching[0]
  );
}

// Voices load asynchronously in some browsers (Chrome); touching getVoices() early starts the load.
if (speechSupported()) window.speechSynthesis.getVoices();

/**
 * Speaks text, cancelling anything already playing. Returns false if speech is unavailable.
 * Note: iOS Safari only allows speech after the user has interacted with the page,
 * so auto-play on the very first card may be silent until the first tap.
 */
export function speak(text: string, lang = "en-US"): boolean {
  if (!speechSupported() || !text.trim()) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  const voice = pickVoice(lang);
  if (voice) utterance.voice = voice;
  utterance.rate = 0.9;
  synth.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}
