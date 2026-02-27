// stt-vosk.js — Vosk browser-based speech recognition (WASM, runs in Web Worker)
// Uses vosk-browser package for offline, free STT with decent accuracy.
// Model is downloaded once on first use (~40MB) and cached in browser storage.

const VOSK_MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';

const VoskSTT = {
  model: null,
  loading: false,
  loadError: null,

  async ensureModel() {
    if (this.model) return this.model;
    if (this.loading) {
      // Wait for in-progress load
      while (this.loading) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (this.model) return this.model;
      throw new Error(this.loadError || 'Model failed to load');
    }

    this.loading = true;
    this.loadError = null;
    try {
      console.log('[VoskSTT] Loading model from', VOSK_MODEL_URL);
      // Vosk is loaded as a UMD global via <script> tag
      const model = new Vosk.Model(VOSK_MODEL_URL);
      // Wait for model to be ready
      model.on('load', () => {
        console.log('[VoskSTT] Model loaded successfully');
      });
      model.on('error', (msg) => {
        console.error('[VoskSTT] Model error:', msg);
      });

      // Poll until ready (model.ready becomes true after WASM loads)
      let waited = 0;
      while (!model.ready && waited < 60000) {
        await new Promise((r) => setTimeout(r, 300));
        waited += 300;
      }
      if (!model.ready) {
        throw new Error('Model loading timed out after 60s');
      }

      this.model = model;
      this.loading = false;
      return model;
    } catch (err) {
      this.loadError = err.message;
      this.loading = false;
      throw err;
    }
  },

  /**
   * Record audio from microphone while PTT is held, then transcribe with Vosk.
   * @param {Function} isPTTActive - Returns true while PTT is pressed
   * @param {string} [grammar] - Optional JSON array of expected phrases for constrained recognition
   * @returns {Promise<string>} Transcribed text
   */
  async transcribe(isPTTActive, grammar) {
    const model = await this.ensureModel();

    // Create recognizer with grammar constraint if provided
    const recognizer = grammar
      ? new model.KaldiRecognizer(16000, grammar)
      : new model.KaldiRecognizer(16000);

    let finalText = '';
    let partialText = '';

    recognizer.on('result', (message) => {
      const text = message.result?.text || '';
      if (text) {
        finalText += (finalText ? ' ' : '') + text;
        console.log('[VoskSTT] Result:', text);
      }
    });

    recognizer.on('partialresult', (message) => {
      partialText = message.result?.partial || '';
    });

    // Get microphone audio at 16kHz
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: 16000,
      },
    });

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (isPTTActive()) {
        try {
          recognizer.acceptWaveform(event.inputBuffer);
        } catch (e) {
          // Recognizer may not be ready yet
        }
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    // Wait for PTT to be released
    while (isPTTActive()) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Small delay to let final audio chunks process
    await new Promise((r) => setTimeout(r, 500));

    // Retrieve any remaining buffered result
    recognizer.retrieveFinalResult();
    // Wait a bit for the final result event
    await new Promise((r) => setTimeout(r, 300));

    // Cleanup
    processor.disconnect();
    source.disconnect();
    audioContext.close();
    stream.getTracks().forEach((t) => t.stop());
    recognizer.remove();

    const result = finalText || partialText;
    console.log(`[VoskSTT] Final transcription: "${result}"`);
    return result;
  },
};
