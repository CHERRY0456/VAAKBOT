# 🎙️VaakBot: Real-Time Voice Assistant (POC)
![Branch](https://img.shields.io/badge/V_Jai_Sri_Charan-white)
![Python](https://img.shields.io/badge/Python-3.10-blue)
![Framework](https://img.shields.io/badge/FastAPI-ff4b4b)
![Model](https://img.shields.io/badge/TypeScript_Backend-Node_&_Express-green)
![Library](https://img.shields.io/badge/TypeScript_Frontend-Vanilla-purple)

This repository contains the proof-of-concept (POC) for VaakBot, a real-time voice assistant designed for noisy environments. It demonstrates a low-latency, privacy-first audio processing pipeline using edge-based noise suppression and cloud-based intent routing.

## 📂 Folder Architecture
```
VAAKBOT/
├── vaakbot-frontend/           # Edge Layer: Client-side UI & Audio Engineering
│   ├── public/                 # Static assets
│   ├── src/
│   │   └── main.ts             # VAD gating, RNNoise WASM, AudioWorklet logic
│   ├── index.html              # Citizen-ready chat interface
│   ├── package.json            # Frontend dependencies (Vite)
│   └── tsconfig.json           # Strict TS configuration
│
├── vaakbot-backend/            # Cloud & Logic Layer: Secure API & AI Orchestration
│   ├── server.ts               # Express endpoints, RAM buffering, Gemini SDK integration
│   ├── package.json            # Backend dependencies (@google/genai, express, multer)
│   ├── tsconfig.json           # Node.js TS configuration
│   └── .env                    # (Git ignored) Secure storage for GEMINI_API_KEY
│
├── .gitignore                  # Master gitignore for node_modules and .env
└── README.md                   # Architecture documentation
```
**Follow the exact architecture to run the things smoothly**

## 🏗️ Architecture 

```mermaid
graph TD
    %% Styling for visual hierarchy
    classDef edge fill:#f0f9ff,stroke:#0284c7,stroke-width:2px;
    classDef cloud fill:#fdf4ff,stroke:#c026d3,stroke-width:2px;
    classDef logic fill:#f0fdf4,stroke:#16a34a,stroke-width:2px;
    classDef security fill:#fffbeb,stroke:#d97706,stroke-width:2px,stroke-dasharray: 5 5;

    subgraph EdgeLayer [1. Edge Side - Vite/Vanilla TS]
        A[Mic Input] --> B[AudioWorklet Thread]
        B --> C[RNNoise WASM Denoise]
        C --> D{VAD Gating}
        D -- silence/noise --> E[Drop Frame]
        D -- Speech --> F[Speech Buffer]
        F --> G[Auto Stop Trigger]
        G --> H[Float32 to 16-bit PCM]
        H --> I[Audio Blob]
    end
    class EdgeLayer edge;

    subgraph TransitLayer [Data in Transit]
        I -- TLS 1.3 / POST --> J[Node.js / Express Backend]
    end
    class TransitLayer security;

    subgraph CloudLayer [2. Cloud Side Processing]
        J --> K[In-Memory Buffer / Multer]
        K --> L[google/genai SDK]
        L --> M[Gemini 2.5 Flash]
        M --> N[Structured JSON Output]
    end
    class CloudLayer cloud;

    subgraph DeveloperLayer [3. Developer Side Control]
        N --> O{Confidence Logic}
        O -- >= 0.85 --> P[Tier 1: ACCEPT]
        O -- 0.65 - 0.84 --> Q[Tier 2: CONFIRM]
        O -- < 0.65 --> R[Tier 3: REJECT]
    end
    class DeveloperLayer logic;

    %% UI Outcomes
    P --> S([UI: Success Response])
    Q --> T([UI: Dynamic Dialect Confirmation])
    R --> U([UI: Auto-Retry Mic])
```

## 🚀 Upgrades: Python POC to TypeScript Monorepo
The system has been heavily upgraded from its initial Python/FastAPI iteration into a modern, production-ready TypeScript stack.

**1. Frontend Upgrades (Vite + Vanilla TS)**:
Citizen-Ready Interface: Upgraded from a developer debugging dashboard to a clean, highly responsive chat UI.

Interactive Confirmation: Dynamically displays conversational chat bubbles when the AI is unsure of the audio.

Auto-Retry & Self-Healing: If the audio is rejected due to noise, the UI automatically resets the Web Audio API context and re-triggers the microphone after a 1.5-second delay to try again without user intervention.

**2. Backend Upgrades (Node.js + Express)**:
Zero-Disk Processing: Replaced Python's io.BytesIO with Node.js multer.memoryStorage(). The backend reconstructs standard 48kHz WAV headers directly in RAM, ensuring zero trace files are left on the server.

Strict Structured Outputs: The new @google/genai SDK enforces a strict TypeScript-mapped JSON schema (Type.OBJECT). This eliminates hallucinated text and guarantees predictable API responses.

Dynamic Mother-Tongue Translation: Governed by strict systemInstructions, the AI listens to code-switched audio (e.g., Hinglish) and dynamically returns the ui_confirm and ui_reject strings translated into the exact regional dialect the user spoke.

## 💻 How to Run Locally
**Prerequisites**:

1. Node.js (v18 or higher)

2. A valid Google Gemini API Key

**Step 1: Start the Backend Core**:
- Open a terminal and navigate to the backend folder:

```Bash
cd vaakbot-backend
```
- Install dependencies:

```Bash
npm install
```
- Create a .env file in the vaakbot-backend directory and add your API key:

```Code snippet
GEMINI_API_KEY="your_actual_api_key_here"
PORT=8000
```
- Start the server (runs via tsx for seamless TypeScript execution):

```Bash
npm run dev
```

The server will securely listen on http://localhost:8000.

**Step 2: Start the Frontend UI**: 
- Open a new terminal window and navigate to the frontend folder:

```Bash
cd vaakbot-frontend
```

- Install dependencies:

```Bash
npm install
```

- Launch the Vite development server:

```Bash
npm run dev
```

Open the provided localhost link (typically http://localhost:5173) in your browser to interact with VaakBot.
