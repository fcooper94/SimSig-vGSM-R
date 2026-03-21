"""
Chatterbox TTS Server — local API for vGSM-R
Exposes a single POST /tts endpoint that accepts text + voice ID,
returns MP3 audio using Chatterbox Turbo with voice cloning.
Each voice gets a unique personality (pitch, speed, expressiveness).
Includes phrase caching for instant delivery of common lines.
"""

import hashlib
import io
import os
import random
import time
from pathlib import Path

import tempfile

import numpy as np
import torch
import torchaudio
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel

VOICES_DIR = Path(os.environ.get("VOICES_DIR", "C:/Voices"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

app = FastAPI(title="Chatterbox TTS Server")

_model = None
_phrase_cache = {}  # (text_lower, voice_id) → MP3 bytes

# Common phrases pre-generated at startup for instant delivery
COMMON_PHRASES = [
    # Goodbye lines (driver says after signaller signs off)
    "Right, cheers, bye.",
    "Ta, bye now.",
    "Cheers, bye bye.",
    "Nice one, ta, bye.",
    "Alright, cheers, bye.",
    "Right oh, cheers, bye.",
    "Ok, Thanks. Bye.",
    "Right, thanks for letting me know. Bye.",
    "Ok, cheers. Bye.",
    "Thanks. Bye.",
    # Short acknowledgements
    "Ok, thanks.",
    "Ok.",
    "Ok Thanks",
    "Ok, Thanks. I will take a look now",
    # Retry prompt
    "Can you say again please",
    # Common readbacks (no headcode — these survive phoneticize unchanged)
    "Hello Driver. Please continue and obey all other signals",
    "Ok, will do. Thanks",
    "Ok, I will let them know. Thanks",
    "Ok, I will hold them. Thanks",
    "Ok, Thanks. Bye",
    "Permission granted",
]


def _hash_voice(voice_id: str) -> int:
    """Deterministic hash for a voice ID — used to assign personality traits."""
    return int(hashlib.md5(voice_id.encode()).hexdigest(), 16)


def _voice_personality(voice_id: str) -> dict:
    """
    Derive a unique but consistent personality for each voice.
    Variety comes from different reference samples — no post-processing pitch/speed
    manipulation which degrades quality.
    """
    h = _hash_voice(voice_id)

    # Generation params (Turbo-compatible) — slight variation per voice
    temperature = 0.75 + ((h >> 8) % 15) / 100   # 0.75–0.89
    top_p = 0.92 + ((h >> 16) % 8) / 100         # 0.92–0.99
    top_k = 900 + ((h >> 24) % 200)               # 900–1099

    return {
        "temperature": round(temperature, 2),
        "top_p": round(top_p, 2),
        "top_k": top_k,
    }


def get_model():
    global _model
    if _model is None:
        print(f"[TTS] Loading Chatterbox Turbo on {DEVICE}...")
        t0 = time.time()
        # Patch out Perth watermarker if it fails to load (missing native binaries)
        try:
            import resemble_perth as perth
            if perth.PerthImplicitWatermarker is None:
                raise ImportError("PerthImplicitWatermarker is None")
        except (ImportError, TypeError, AttributeError):
            import resemble_perth as perth
            class _NoOpWatermarker:
                def watermark(self, wav, sr): return wav
            perth.PerthImplicitWatermarker = _NoOpWatermarker
            print("[TTS] Perth watermarker not available - disabled")
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        _model = ChatterboxTurboTTS.from_pretrained(device=DEVICE)
        print(f"[TTS] Model loaded in {time.time() - t0:.1f}s")
    return _model


def scan_voices():
    voices = {}
    if not VOICES_DIR.exists():
        print(f"[TTS] Warning: voices directory {VOICES_DIR} not found")
        return voices
    for f in sorted(VOICES_DIR.glob("*.wav")):
        voices[f.stem] = f
    print(f"[TTS] Found {len(voices)} voice samples:")
    for vid in voices:
        p = _voice_personality(vid)
        print(f"  {vid}: temp={p['temperature']}, top_p={p['top_p']}, top_k={p['top_k']}")
    return voices


VOICES = scan_voices()

# Gender tags — female voice samples
FEMALE_VOICES = {'signaller3', 'signaller4', 'signaller20'}



def generate_audio(text: str, ref_path: Path, voice_id: str) -> bytes:
    """Generate TTS audio with voice-specific personality and return WAV bytes."""
    model = get_model()
    p = _voice_personality(voice_id)

    wav = model.generate(
        text,
        audio_prompt_path=str(ref_path),
        temperature=p["temperature"],
        top_p=p["top_p"],
        top_k=p["top_k"],
    )

    buf = io.BytesIO()
    torchaudio.save(buf, wav.cpu(), 24000, format="wav")
    buf.seek(0)
    return buf.read()


def warm_cache():
    """Pre-generate common phrases for a subset of voices."""
    if not VOICES:
        return
    voice_ids = list(VOICES.keys())
    cache_voices = voice_ids  # Cache for ALL voices
    total = len(COMMON_PHRASES) * len(cache_voices)
    print(f"[Cache] Pre-generating {total} phrases across {len(cache_voices)} voices...")
    t0 = time.time()
    count = 0
    for vid in cache_voices:
        ref_path = VOICES[vid]
        for phrase in COMMON_PHRASES:
            key = (phrase.lower().strip(), vid)
            if key in _phrase_cache:
                continue
            try:
                audio = generate_audio(phrase, ref_path, vid)
                _phrase_cache[key] = audio
                count += 1
            except Exception as e:
                print(f"[Cache] Failed '{phrase[:40]}' / {vid}: {e}")
    print(f"[Cache] Warmed {count} phrases in {time.time() - t0:.1f}s "
          f"({len(_phrase_cache)} total cached)")


class TTSRequest(BaseModel):
    text: str
    voice_id: str = ""


@app.get("/voices")
def list_voices():
    """Return available voice IDs with their personality traits."""
    result = []
    for vid in VOICES:
        p = _voice_personality(vid)
        result.append({
            "id": vid,
            "name": vid,
            "gender": "female" if vid in FEMALE_VOICES else "male",
            "accent": "british",
        })
    return result


@app.post("/tts")
def speak(req: TTSRequest):
    if not VOICES:
        raise HTTPException(500, "No voice samples found")

    # Pick voice
    if req.voice_id and req.voice_id in VOICES:
        voice_id = req.voice_id
    else:
        voice_id = random.choice(list(VOICES.keys()))
    ref_path = VOICES[voice_id]

    # Check phrase cache
    cache_key = (req.text.lower().strip(), voice_id)
    if cache_key in _phrase_cache:
        print(f"[TTS] Cache HIT: '{req.text[:50]}' / {voice_id}")
        return Response(content=_phrase_cache[cache_key], media_type="audio/wav")

    # Generate with voice personality
    t0 = time.time()
    audio = generate_audio(req.text, ref_path, voice_id)
    gen_time = time.time() - t0
    print(f"[TTS] {gen_time:.2f}s voice={voice_id} text={req.text[:50]}...")

    _phrase_cache[cache_key] = audio
    if len(_phrase_cache) > 500:
        del _phrase_cache[next(iter(_phrase_cache))]

    return Response(content=audio, media_type="audio/wav")


# ── Whisper STT ──────────────────────────────────────────────────────

_whisper_model = None
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")  # tiny, base, small


def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        print(f"[STT] Loading Whisper '{WHISPER_MODEL_SIZE}' on {DEVICE}...")
        t0 = time.time()
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(
            WHISPER_MODEL_SIZE,
            device="cuda" if DEVICE == "cuda" else "cpu",
            compute_type="float16" if DEVICE == "cuda" else "int8",
        )
        print(f"[STT] Whisper loaded in {time.time() - t0:.1f}s")
    return _whisper_model


@app.post("/stt")
async def transcribe(file: UploadFile = File(...)):
    """Transcribe audio (WAV/WebM/any ffmpeg format) → text."""
    model = get_whisper()

    # Write upload to temp file (faster-whisper needs a file path or numpy array)
    suffix = ".wav" if "wav" in (file.content_type or "") else ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        t0 = time.time()
        segments, info = model.transcribe(
            tmp_path,
            language="en",
            beam_size=3,
            vad_filter=True,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        elapsed = time.time() - t0
        print(f"[STT] {elapsed:.2f}s — '{text}' (lang={info.language} prob={info.language_probability:.2f})")
        return {"text": text}
    except Exception as e:
        print(f"[STT] Error: {e}")
        return {"text": "", "error": str(e)}
    finally:
        os.unlink(tmp_path)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "model_loaded": _model is not None,
        "whisper_loaded": _whisper_model is not None,
        "whisper_model": WHISPER_MODEL_SIZE,
        "voices": len(VOICES),
        "cached_phrases": len(_phrase_cache),
    }


if __name__ == "__main__":
    import uvicorn
    get_model()
    get_whisper()  # Pre-load Whisper so first STT is fast
    # warm_cache()  # Disabled for dev — enable on production server
    uvicorn.run(app, host="0.0.0.0", port=8099)
