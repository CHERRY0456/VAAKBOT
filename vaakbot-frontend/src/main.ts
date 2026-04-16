// ─── CONFIGURATION ────────────────────────────────────────────────
const SAMPLE_RATE = 48000;
const FRAME_SIZE = 480; 
const SILENCE_FRAMES_MAX = 200; // 2.0s silence auto-stop
const VAD_THRESHOLD = 0.85; 
const BACKEND_URL = "http://localhost:8000/process";

// ─── STATE ────────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processorNode: AudioWorkletNode | null = null;

let isRecording: boolean = false;
let rawBuffer: Float32Array = new Float32Array(16384);
let rawBufferCount: number = 0;
let speechBuffer: Float32Array[] = [];      
let hasSpoken: boolean = false;
let silenceFrames: number = 0;
let consecutiveSpeechFrames: number = 0;

// RNNoise WASM
let rnnoiseModule: any = null;
let rnnoiseState: number | null = null;
let rnnoiseProcess: Function | null = null;
let rnnoiseReady: boolean = false;
let rnnoiseInputPtr: number | null = null;
let rnnoiseOutputPtr: number | null = null;

// Pending query state for confirmation
let pendingQuery: any = null;

// ─── UI FUNCTIONS ─────────────────────────────────────────────────
function updateStatus(text: string, color: string = '#10b981'): void {
    const statusEl = document.getElementById('systemStatus') as HTMLDivElement;
    statusEl.innerHTML = `<div class="status-dot" style="background:${color}"></div> ${text}`;
}

function addMessage(text: string, sender: 'bot' | 'user', showActions: boolean = false): void {
    const chatArea = document.getElementById('chatArea') as HTMLDivElement;
    const wrapper = document.createElement('div');
    wrapper.className = `msg-wrapper ${sender}`;
    
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let html = `<div class="msg-bubble">${text}</div><div class="msg-time">${time}</div>`;
    
    if (showActions) {
        html += `
            <div class="confirm-actions" id="actionGrp">
                <button class="btn-action yes" id="btnYes">✅ Yes, proceed</button>
                <button class="btn-action no" id="btnNo">🔄 No, re-record</button>
            </div>
        `;
    }
    
    wrapper.innerHTML = html;
    chatArea.appendChild(wrapper);
    chatArea.scrollTop = chatArea.scrollHeight;

    if (showActions) {
        document.getElementById('btnYes')?.addEventListener('click', () => confirmQuery(true));
        document.getElementById('btnNo')?.addEventListener('click', () => confirmQuery(false));
    }
}

// ─── INITIALIZATION (WASM) ────────────────────────────────────────
window.addEventListener('load', async () => {
    updateStatus('Loading audio engine...', '#f59e0b');
    try {
        const mod = await import('https://unpkg.com/@jitsi/rnnoise-wasm@0.2.1/dist/rnnoise-sync.js' as any);
        const factory = mod.default || mod.createRNNoiseModule || mod;
        rnnoiseModule = await factory();
        rnnoiseProcess = rnnoiseModule._rnnoise_process_frame;
        rnnoiseInputPtr = rnnoiseModule._malloc(FRAME_SIZE * 4);
        rnnoiseOutputPtr = rnnoiseModule._malloc(FRAME_SIZE * 4);
        rnnoiseState = rnnoiseModule._rnnoise_create();
        rnnoiseReady = true;
        updateStatus('Ready', '#10b981');
    } catch (e) {
        updateStatus('Failed to load audio engine', '#ef4444');
    }

    const btnMic = document.getElementById('btnMic') as HTMLButtonElement;
    btnMic.addEventListener('click', toggleRecording);
});

// ─── AUDIO ENGINE ─────────────────────────────────────────────────
function processFrame(frame32: Float32Array): { cleaned: Float32Array, vadProb: number } {
    if (!rnnoiseReady) return { cleaned: frame32, vadProb: 1.0 };
    
    const heapF32In = new Float32Array(rnnoiseModule.HEAPF32.buffer, rnnoiseInputPtr!, FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) heapF32In[i] = frame32[i] * 32768.0;

    const vadProb = rnnoiseProcess!(rnnoiseState, rnnoiseOutputPtr, rnnoiseInputPtr);

    const heapF32Out = new Float32Array(rnnoiseModule.HEAPF32.buffer, rnnoiseOutputPtr!, FRAME_SIZE);
    const cleaned = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) cleaned[i] = heapF32Out[i] / 32768.0;

    return { cleaned, vadProb };
}

function handleAudioData(input: Float32Array): void {
    if (!isRecording) return;
    
    if (rawBufferCount + input.length > rawBuffer.length) {
        const newBuf = new Float32Array(rawBuffer.length * 2);
        newBuf.set(rawBuffer);
        rawBuffer = newBuf;
    }
    rawBuffer.set(input, rawBufferCount);
    rawBufferCount += input.length;

    while (rawBufferCount >= FRAME_SIZE) {
        const frame = rawBuffer.slice(0, FRAME_SIZE);
        rawBuffer.copyWithin(0, FRAME_SIZE, rawBufferCount);
        rawBufferCount -= FRAME_SIZE;

        const { cleaned, vadProb } = processFrame(frame);
        const isSpeech = vadProb > VAD_THRESHOLD;

        if (isSpeech) {
            consecutiveSpeechFrames++;
            if (consecutiveSpeechFrames >= 30) hasSpoken = true;
            silenceFrames = 0;
            speechBuffer.push(cleaned);
        } else {
            consecutiveSpeechFrames = 0; 
            silenceFrames++;
            if (hasSpoken) speechBuffer.push(cleaned); 
        }

        if (hasSpoken && silenceFrames >= SILENCE_FRAMES_MAX) {
            stopRecording();
            break; 
        }
    }
}

// ─── RECORDING CONTROLS ───────────────────────────────────────────
async function toggleRecording(): Promise<void> {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

async function startRecording(): Promise<void> {
    if (!rnnoiseReady) return;
    updateStatus('Listening...', '#ef4444');
    
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: SAMPLE_RATE, echoCancellation: true, noiseSuppression: true } 
        });
    } catch (e) {
        updateStatus('Microphone access denied', '#ef4444');
        return;
    }

    const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
    audioCtx = new AudioCtxClass({ sampleRate: SAMPLE_RATE });
    
    const workletCode = `
        class RecorderWorklet extends AudioWorkletProcessor {
            process(inputs) {
                if (inputs[0] && inputs[0].length > 0) this.port.postMessage(inputs[0][0]);
                return true;
            }
        }
        registerProcessor('recorder-worklet', RecorderWorklet);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    
    await audioCtx!.audioWorklet.addModule(URL.createObjectURL(blob));
    processorNode = new AudioWorkletNode(audioCtx!, 'recorder-worklet');
    processorNode.port.onmessage = (e: MessageEvent) => handleAudioData(e.data);

    const sourceNode = audioCtx!.createMediaStreamSource(mediaStream);
    sourceNode.connect(processorNode);

    speechBuffer = [];
    rawBufferCount = silenceFrames = consecutiveSpeechFrames = 0;
    hasSpoken = false;
    isRecording = true;

    const btn = document.getElementById('btnMic') as HTMLButtonElement;
    btn.classList.add('recording');
}

async function stopRecording(): Promise<void> {
    if (!isRecording) return;
    isRecording = false;

    const btn = document.getElementById('btnMic') as HTMLButtonElement;
    btn.classList.remove('recording');
    btn.disabled = true;

    if (processorNode) processorNode.disconnect();
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close();

    if (hasSpoken && silenceFrames > 0) {
        speechBuffer = speechBuffer.slice(0, Math.max(0, speechBuffer.length - silenceFrames));
    }

    if (speechBuffer.length === 0) {
        updateStatus('Ready', '#10b981');
        btn.disabled = false;
        return;
    }

    const totalLength = speechBuffer.reduce((a, f) => a + f.length, 0);
    const flat = new Float32Array(totalLength);
    let offset = 0;
    for (const f of speechBuffer) { 
        flat.set(f, offset); 
        offset += f.length; 
    }

    await sendToBackend(buildWAV(flat, SAMPLE_RATE));
}

// ─── NETWORK & 3-TIER LOGIC ───────────────────────────────────────
function buildWAV(float32Samples: Float32Array, sampleRate: number): Blob {
    const int16 = new Int16Array(float32Samples.length);
    for (let i = 0; i < float32Samples.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Samples[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    const buffer = new ArrayBuffer(44 + int16.byteLength);
    const view = new DataView(buffer);
    const write = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    
    write(0, 'RIFF'); view.setUint32(4, 36 + int16.byteLength, true);
    write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, int16.byteLength, true);
    
    new Int16Array(buffer, 44).set(int16);
    return new Blob([buffer], { type: 'audio/wav' });
}

async function sendToBackend(wavBlob: Blob): Promise<void> {
    updateStatus('Processing audio...', '#3b82f6');
    const form = new FormData();
    form.append('audio', wavBlob, 'recording.wav');

    try {
        const resp = await fetch(BACKEND_URL, { method: 'POST', body: form });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        handleResponseLogic(data);
    } catch (e) {
        updateStatus('Connection Error', '#ef4444');
        addMessage("Sorry, I couldn't reach the server. Please check your connection.", 'bot');
        (document.getElementById('btnMic') as HTMLButtonElement).disabled = false;
    }
}

function handleResponseLogic(data: any): void {
    const btnMic = document.getElementById('btnMic') as HTMLButtonElement;
    btnMic.disabled = false;
    updateStatus('Ready', '#10b981');
    
    if (!data.text) return;
    addMessage(data.text, 'user');

    if (data.verdict === "ACCEPT") {
        addMessage("Audio processed successfully. Confidence is high.", 'bot');
    } else if (data.verdict === "CONFIRM") {
        pendingQuery = data;
        addMessage(`${data.ui_confirm} <b>${data.text}</b>?`, 'bot', true);
    } else {
        addMessage(data.ui_reject, 'bot');
        setTimeout(() => {
            if(!isRecording) startRecording();
        }, 1500);
    }
}

function confirmQuery(isConfirmed: boolean): void {
    const actionGrp = document.getElementById('actionGrp');
    if (actionGrp) actionGrp.style.display = 'none';
    
    if (isConfirmed && pendingQuery) {
        addMessage(pendingQuery.scheme_data || "Query processed successfully.", 'bot');
    } else {
        addMessage("Okay, let's try again. Tap the mic when you're ready.", 'bot');
    }
    pendingQuery = null;
}