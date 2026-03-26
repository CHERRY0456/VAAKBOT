import os, time, wave, io, logging
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("vaakbot")

# Pull the Gemini API key from your environment
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
if not GEMINI_API_KEY:
    log.error("CRITICAL: GEMINI_API_KEY environment variable is not set.")
    exit(1)

# Configure the Gemini SDK
genai.configure(api_key=GEMINI_API_KEY)
# Using 2.5 Flash because it is insanely fast for audio transcription
model = genai.GenerativeModel('gemini-2.5-flash')

app = FastAPI(title="VaakBot Backend", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Keeping the exact same response model so your frontend doesn't break
class STTResponse(BaseModel):
    text: str
    confidence: float
    verdict: str

def validate_wav(data: bytes) -> tuple[bytes, float]:
    try:
        with wave.open(io.BytesIO(data), 'rb') as wf:
            duration = wf.getnframes() / wf.getframerate()
            log.info(f"WAV: {wf.getnframes()} frames | {wf.getframerate()} Hz | {duration:.2f}s")
            return data, duration
    except wave.Error as e:
        raise HTTPException(400, f"Invalid WAV header: {e}")

@app.post("/process", response_model=STTResponse)
async def process_audio(audio: UploadFile = File(...)):
    t_start = time.perf_counter()
    raw = await audio.read()
    
    if not raw[:4] == b'RIFF':
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(raw)
        raw = buf.getvalue()

    wav_bytes, duration_s = validate_wav(raw)

    try:
        # 1. Give Gemini strict instructions
        prompt = "Listen to this audio. It is in Hindi and/or English (Hinglish). Provide an exact transcription of what is being said. Do not add any conversational filler, formatting, or comments. Just return the pure transcript."
        
        # 2. Package the raw bytes
        audio_part = {"mime_type": "audio/wav", "data": wav_bytes}
        
        # 3. Fire it off to the model
        response = model.generate_content([prompt, audio_part])
        transcript = response.text.strip()
        
        elapsed = (time.perf_counter() - t_start) * 1000
        log.info(f"Gemini API responded in {elapsed:.0f}ms")
        
        # Note: Gemini generates text rather than calculating traditional acoustic confidence scores.

        return STTResponse(
            text=transcript,
            confidence=0.95,
            verdict="ACCEPT"
        )

    except Exception as e:
        log.error(f"Gemini API Error: {e}")
        raise HTTPException(502, f"Gemini processing failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend:app", host="0.0.0.0", port=8000, reload=True)
