import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_API_KEY) {
    console.error("CRITICAL: GEMINI_API_KEY environment variable is not set. Setup your .env file.");
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const app = express();

app.use(cors({
    origin: '*',
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['*']
}));

const upload = multer({ storage: multer.memoryStorage() });

// Structured schema remains exactly as you defined it
const geminiEvaluationSchema = {
    type: Type.OBJECT,
    properties: {
        transcript: {
            type: Type.STRING,
            description: "The exact words spoken in the audio. MUST be verbatim: no normalization, no punctuation changes, no added words, no translation, same casing and spacing as spoken."
        },
        confidence_score: {
            type: Type.NUMBER,
            description: "A float between 0.0 and 1.0 representing the model's confidence in the verbatim transcript."
        },
        ui_confirm: {
            type: Type.STRING,
            description: "A polite phrase asking 'Did you mean to ask about:' translated into the EXACT language or dialect the user spoke."
        },
        ui_reject: {
            type: Type.STRING,
            description: "A phrase saying 'Sorry, there is too much noise. Can you speak again?' translated into the user's language."
        }
    },
    required: ["transcript", "confidence_score", "ui_confirm", "ui_reject"]
};

// Memory-safe WAV enforcement
function ensure48khzWav(rawBytes: Buffer): Buffer {
    try {
        const isRiff = rawBytes.toString('ascii', 0, 4) === 'RIFF';
        const rawFrames = isRiff ? rawBytes.subarray(44) : rawBytes;

        const byteLength = rawFrames.length;
        const sampleRate = 48000;
        const header = Buffer.alloc(44);

        header.write('RIFF', 0);
        header.writeUInt32LE(36 + byteLength, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * 2, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(byteLength, 40);

        return Buffer.concat([header, rawFrames]);
    } catch (e) {
        console.error(`WAV conversion failed: ${e}`);
        throw new Error("Invalid audio format received.");
    }
}

function getVerdict(confidence: number): string {
    if (confidence > 0.85) return "ACCEPT";
    if (confidence >= 0.65) return "CONFIRM";
    return "REJECT";
}

// Moving the strict mandates to a System Instruction for deeper architectural adherence
const strictSystemInstruction = `
You are a highly precise Automatic Speech Recognition (ASR) engine.
**MANDATES (must follow exactly):**
1. You must output strictly in JSON matching the provided schema.
2. The transcript MUST be verbatim. Do NOT normalize, translate, or paraphrase. 
3. You will heavily encounter mixed languages like Hinglish and regional dialects. Preserve the exact code-switching and slang used by the speaker. Do not convert spoken Hindi/Hinglish into formal English.
4. If the audio is completely unintelligible or contains no speech, set transcript to an empty string "" and confidence_score to 0.0.
5. If there are multiple speakers, transcribe only the primary user.
6. Do NOT output any explanation, markdown formatting outside of the JSON block, or metadata.
`;

// CORE ENDPOINT
app.post('/process', upload.single('audio'), async (req: Request, res: Response): Promise<void> => {
    const tStart = performance.now();

    if (!req.file) {
        res.status(400).json({ error: "No audio file provided." });
        return;
    }

    try {
        const wavBuffer = ensure48khzWav(req.file.buffer);

        // A simple, direct prompt since the rules are now in the system instruction
        const userPrompt = "Transcribe the attached audio verbatim and evaluate confidence.";

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                userPrompt,
                { inlineData: { data: wavBuffer.toString("base64"), mimeType: "audio/wav" } }
            ],
            config: {
                systemInstruction: strictSystemInstruction,
                responseMimeType: "application/json",
                responseSchema: geminiEvaluationSchema,
                temperature: 0.0
            }
        });

        // Because we use responseSchema, response.text is guaranteed to be a JSON string.
        // We can safely parse it directly without the heavy fallback loops.
        let parsedResult: any;
        try {
            parsedResult = JSON.parse(response.text || "{}");
        } catch (parseErr) {
            console.error("Failed to parse model response:", parseErr);
            throw new Error("AI returned malformed data.");
        }

        // Validate and coerce fields safely
        const transcript = typeof parsedResult.transcript === 'string' ? parsedResult.transcript : "";
        const confidence = typeof parsedResult.confidence_score === 'number'
            ? parsedResult.confidence_score
            : parseFloat(parsedResult.confidence_score || "0") || 0.0;

        const verdict = getVerdict(confidence);
        const elapsed = Math.round(performance.now() - tStart);
        console.log(`Processed in ${elapsed}ms | Conf: ${confidence.toFixed(2)} | Verdict: ${verdict}`);

        // Return exactly what the model provided
        res.json({
            text: transcript,
            confidence: confidence,
            verdict: verdict,
            ui_confirm: parsedResult.ui_confirm || "Did you mean:",
            ui_reject: parsedResult.ui_reject || "Please speak again."
        });

    } catch (e: any) {
        console.error(`Pipeline Error: ${e?.message || e}`);
        res.status(502).json({ error: `AI processing failed: ${e?.message || String(e)}` });
    }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`VaakBot Voice Core running on http://localhost:${PORT}`);
});