import os, time, wave, io, logging
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
# ─── THE NEW GOOGLE GENAI SDK ───
from google import genai
from google.genai import types

# ─── SETUP & CONFIGURATION ───
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("vaakbot")

load_dotenv()  # Load environment variables from .env file
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY","SECRET KEY")  # Ensure you have this in your .env file
if not GEMINI_API_KEY:
    log.error("CRITICAL: GEMINI_API_KEY environment variable is not set. Setup your .env file.")
    exit(1)

# Initialize the new robust GenAI client
client = genai.Client(api_key=GEMINI_API_KEY)

app = FastAPI(title="VaakBot Voice Core", version="4.0.0")

# Security: allow_credentials MUST be False when origins is "*"
app.add_middleware( 
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False, 
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── DATA MODELS ───

# 1. This dictates what the Frontend receives
class STTResponse(BaseModel):
    text: str
    confidence: float
    verdict: str
    ui_confirm: str
    ui_reject: str

# 2. This FORCES Gemini to never break our JSON structure
class GeminiEvaluation(BaseModel):
    transcript: str = Field(description="The exact words spoken in the audio.")
    confidence_score: float = Field(description="A float between 0.0 and 1.0. Deduct points for heavy background noise.")
    ui_confirm: str = Field(description="A polite phrase asking 'Did you mean to ask about:' translated into the EXACT language or dialect the user spoke.")
    ui_reject: str = Field(description="A phrase saying 'Sorry, there is too much noise. Can you speak again?' translated into the user's language.")

# ─── HELPER FUNCTIONS ───
def ensure_48khz_wav(raw_bytes: bytes) -> bytes:
    """Validates and enforces a 48kHz WAV structure in memory without saving to disk."""
    try:
        # If it's not a RIFF/WAV, or we just want to guarantee the format
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(48000)
            
            # Skip the 44-byte WAV header from the frontend before writing raw frames
            # to prevent static pops in the audio evaluation
            raw_frames = raw_bytes[44:] if raw_bytes[:4] == b'RIFF' else raw_bytes
            wf.writeframes(raw_frames)
            
        return buf.getvalue()
    except Exception as e:
        log.error(f"WAV conversion failed: {e}")
        raise HTTPException(400, "Invalid audio format received.")

def get_verdict(confidence: float) -> str:
    """The 3-Tier UX Logic mapped to confidence scores."""
    if confidence > 0.85:
        return "ACCEPT"
    elif confidence >= 0.65:
        return "CONFIRM"
    else:
        return "REJECT"

# ─── CORE ENDPOINT ───
@app.post("/process", response_model=STTResponse)
async def process_audio(audio: UploadFile = File(...)):
    t_start = time.perf_counter()
    
    # 1. Read ephemeral bytes from RAM
    raw_data = await audio.read()
    
    # 2. Enforce secure, standard WAV formatting
    wav_bytes = ensure_48khz_wav(raw_data)

    try:
        prompt = "Listen to this audio and evaluate the speech clarity and content."
        
        # 3. Call Gemini 2.5 Flash using the new SDK and Structured Outputs
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[
                prompt,
                types.Part.from_bytes(data=wav_bytes, mime_type='audio/wav')
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=GeminiEvaluation, # <-- The Magic Bullet for stability
                temperature=0.1 # Keep it strictly factual, no creative hallucinations
            )
        )
        
        # 4. Extract validated data (No json.loads() required!)
        # The SDK automatically maps the JSON string back into a Python dictionary
        # based on our GeminiEvaluation schema.
        import json
        result = json.loads(response.text) 
        
        transcript = result.get("transcript", "")
        confidence = float(result.get("confidence_score", 0.0))
        verdict = get_verdict(confidence)
        
        elapsed = (time.perf_counter() - t_start) * 1000
        log.info(f"⚡ Processed in {elapsed:.0f}ms | Conf: {confidence:.2f} | Verdict: {verdict}")
        
        # 5. Return to Frontend
        return STTResponse(
            text=transcript,
            confidence=confidence,
            verdict=verdict,
            ui_confirm=result.get("ui_confirm", "Did you mean:"),
            ui_reject=result.get("ui_reject", "Please speak again.")
        )

    except Exception as e:
        log.error(f"Pipeline Error: {e}")
        raise HTTPException(502, f"AI processing failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    # Auto-reload makes development much faster
    uvicorn.run("backend:app", host="0.0.0.0", port=8000, reload=True)