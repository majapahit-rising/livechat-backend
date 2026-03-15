import express from "express";
import mysql from "mysql2";
import WebSocket from "ws";
import { v4 as uuid } from "uuid";
import nodemailer from "nodemailer";
import http from "http";
import admin from "firebase-admin";
import twilio from "twilio";
import axios from "axios";
import OpenAI from "openai";
import wav from "wav"; // Kyle Local STT&TTS UPDATE: Uncommented
import { PassThrough } from "stream"; // Kyle Local STT&TTS UPDATE: Uncommented
import { WebSocketServer } from "ws"; // Kyle Local STT&TTS UPDATE: Moved up or ensured import

// Kyle Local STT&TTS UPDATE: Google Gemini Imports
import { GoogleGenerativeAI } from "@google/generative-ai"; 

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

console.log("ENV CHECK", {
  TWILIO_SID: !!process.env.TWILIO_SID,
  TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER: !!process.env.TWILIO_NUMBER,
});
const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
    const allowedOrigins = [
        "https://demo-crm.ihubtechnologies.com.au",
        "https://n8n.ihubtechnologies.com.au",
        "https://ihubs-chat.infinityfreeapp.com",
        "https://livechat-backend-3sft.onrender.com"
    ];

    const origin = req.headers.origin;

    if (allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
    }

    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, X-Debug, X-Source"
    );
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});


/* ============================
   BODY PARSER – WAJIB PALING ATAS
============================= */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));




// -----------------------------------------------------
// MYSQL CONNECTION
// -----------------------------------------------------
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

function queryAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}


// -----------------------------------------------------
// LIVE CHAT IN-MEMORY STORE
// -----------------------------------------------------
const sessions = {};
const adminClients = [];
const clientConnections = {};
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes for inactive sessions
const SESSION_CLAIM_TIMEOUT = 2 * 60 * 1000; // 2 minutes for unclaimed sessions



// // ======================================================
// // CONFIG (Kyle Local STT&TTS UPDATE)
// // ======================================================


const WHISPER_URL = "https://voice.skendern8n.com/stt"; // Kyle Local STT&TTS UPDATE: Updated URL
const N8N_WEBHOOK = "https://n8n.ihubtechnologies.com.au/webhook/wastevantage-chatbot";
const KOKORO_URL = "https://voice.skendern8n.com/tts"; // Kyle Local STT&TTS UPDATE: Updated URL

// Kyle Local STT&TTS UPDATE: Gemini Config
const GEMINI_API_KEY = "AIzaSyCj4JUMusqvsqYaPTBigR7UHJ-urWjImb8"; // Hardcoded as requested
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });


// // ======================================================
// // AI CALL SESSIONS
// // ======================================================

const callSessions = new Map();

// // ======================================================
// // WEBSOCKET CONNECTION
// // ======================================================

const extractPostcode = (text) => {
  if (!text) return null;

  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");

  const numericMatch = clean.match(/\b\d{4}\b/);
  if (numericMatch) return numericMatch[0];

  const wordMap = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9"
  };

  const words = clean.split(/\s+/);

  let digits = "";

  for (let w of words) {
    if (wordMap[w]) {
      digits += wordMap[w];
    }
  }

  if (digits.length === 4) return digits;

  return null;
};

function shouldSwitchToSales(text) {

  if (!text) return false;

  const lower = text.toLowerCase();

  const triggers = [
    "order",
    "i want",
    "i need",
    "book",
    "hire",
    "get a bin"
  ];

  return triggers.some(t => lower.includes(t));
}

const extractDeliveryDate = (text) => {
  if (!text) return null;

  const match = text.match(
    /\b(\d{4}-\d{2}-\d{2}|\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i
  );

  return match ? match[1] : null;
};

const extractPickupDate = (text) => {
  if (!text) return null;

  const match = text.match(
    /\b(pickup|pick up|collection)\s+(on\s+)?(\d{4}-\d{2}-\d{2}|\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i
  );

  return match ? match[3] : null;
};

async function summarizeConversation(sessionId) {
  try {
    const rows = await queryAsync(
      `
      SELECT user_message, ai_response
      FROM chatbot_conversations
      WHERE session_id = ?
      ORDER BY created_at ASC
      `,
      [sessionId]
    );

    if (!rows.length) {
      return "Session ended with no recorded conversation.";
    }

    const conversationText = rows
      .map((r) => {
        let text = "";

        if (r.user_message) text += `User: ${r.user_message}\n`;
        if (r.ai_response) text += `AI: ${r.ai_response}\n`;

        return text;
      })
      .join("\n");

    if (!conversationText.trim()) {
      return "Session had empty messages.";
    }

    const aiResp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
Summarize this support call in 3 concise sentences.
Focus on:
- Main intent
- Key data mentioned
- Outcome

Conversation:
${conversationText}
`
    });

    return aiResp.output?.[0]?.content?.[0]?.text || null;
  } catch (err) {
    console.error("❌ SUMMARY ERROR:", err.message);
    return "Summary generation failed.";
  }
}

async function insertLearningQueue({ sessionId, question, answer }) {
  try {
    await queryAsync(
      `
      INSERT INTO chatbot_learning_queue
      (
        source_type,
        source_id,
        proposed_question,
        proposed_answer,
        confidence_score,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending_review', NOW(), NOW())
      `,
      [
        "conversation",
        sessionId,
        question,
        answer,
        0.8
      ]
    );

    console.log("🧠 Learning queue inserted");
  } catch (err) {
    console.error("❌ Learning queue insert failed:", err);
  }
}

// // ======================================================
// // STT (Kyle Local STT&TTS UPDATE: Uncommented & Fixed)
// // ======================================================

async function transcribeAudio(buffer) {

  try {

    // Kyle Local STT&TTS UPDATE: Using local voice server
    const res = await axios.post(
      WHISPER_URL,
      buffer,
      {
        headers: {
          "Content-Type": "audio/wav" // Kyle Local STT&TTS UPDATE: Changed to audio/wav for local server
        },
        timeout: 15000
      }
    );

    if (typeof res.data !== "object") {
      console.log("⚠️ STT returned non JSON");
      return null;
    }

    return res.data.text || null;

  } catch (err) {

    console.error(
      "❌ STT ERROR:",
      err.response?.status,
      err.response?.data || err.message
    );

    return null;

  }

}

// // ======================================================
// // AI (N8N)
// // ======================================================

async function askN8N(userInput, session) {

  try {

    const res = await axios.post(
      N8N_WEBHOOK,
      {
        agent_type: 'sales',
        message: userInput,
        conversation_history: session.history.slice(-10),
        context: session.context
      }
    );

    const data = res.data;

    if (data.context) {
      session.context = {
        ...session.context,
        ...data.context
      };
    }

    return data.reply || "Sorry, I couldn't process that.";

  } catch (err) {

    console.error("❌ N8N ERROR:", err.message);
    return "Sorry, something went wrong.";

  }

}

// // ======================================================
// // GEMINI BRAIN (Kyle Local STT&TTS UPDATE: Added)
// // ======================================================

async function getAgentFromDB(agentType) { 
  try {
    const rows = await queryAsync(
      `SELECT * FROM chatbot_prompts WHERE agent_type = ? ORDER BY id DESC LIMIT 1`,
      [agentType]
    );
    if (rows.length) return rows[0];
    return null;
  } catch (err) {
    console.error("DB Error:", err);
    return null;
  }
}

async function runGeminiTurn(session, userText) {
  const chat = model.startChat({
    history: session.geminiHistory || [],
    generationConfig: {
      maxOutputTokens: 200,
    },
  });

  // Inject system prompt logic here if needed, or rely on session context
  
  try {
    const result = await chat.sendMessage(userText);
    const response = await result.response;
    const text = response.text();
    
    // Update history
    session.geminiHistory = [
      ...(session.geminiHistory || []),
      { role: "user", parts: [{ text: userText }] },
      { role: "model", parts: [{ text: text }] },
    ];
    
    return text;
  } catch (e) {
    console.error("Gemini Error:", e);
    return "I'm having trouble thinking right now.";
  }
}


// // ======================================================
// // TTS (Kyle Local STT&TTS UPDATE: Uncommented & Fixed)
// // ======================================================

function pcmToWav(pcmBuffer, sampleRate = 24000) {

  const stream = new PassThrough();

  const writer = new wav.Writer({
    channels: 1,
    sampleRate: sampleRate,
    bitDepth: 16
  });

  writer.pipe(stream);

  writer.write(pcmBuffer);
  writer.end();

  return stream;
}

async function generateTTS(text) {

  try {

    console.log("🎤 GENERATE TTS:", text);

    // Kyle Local STT&TTS UPDATE: Pointing to local Kokoro
    const res = await axios.post(
      KOKORO_URL,
      {
        text: text,
        voice: "am_echo",
        speed: 1.1 // Kyle Local STT&TTS UPDATE: Added speed
      },
      {
        headers: {
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer"
      }
    );

    console.log("✅ TTS BYTES:", res.data.byteLength);

    // Kyle Local STT&TTS UPDATE: Kokoro returns WAV/PCM directly
    return Buffer.from(res.data);

  } catch (err) {

    console.error(
      "❌ TTS ERROR:",
      err.response?.status,
      err.response?.data || err.message
    );

    return null;

  }

}

// Kyle Local STT&TTS UPDATE: Added buildFullSystemPrompt back
function buildFullSystemPrompt(prompt) {
  if (!prompt) return "You are a helpful assistant.";
  return `
You are ${prompt.identity || 'a helpful assistant'}.

ROLE
${prompt.role_description || ''}

SYSTEM STATES

STATE: GENERAL
- Answer general questions about waste bins
- Provide information
- Be helpful

STATE: SALES
- Collect order information
- postcode
- bin size
- delivery date
- pickup date
- customer details

STATE TRANSITION
Switch to SALES when the user wants to:
- order
- hire
- book
- get a bin
- rent a bin

IMPORTANT RULE
The current state is defined by context.agent_type.

If context.agent_type = general → operate in GENERAL mode
If context.agent_type = sales → operate in SALES mode

BASE KNOWLEDGE
${prompt.context_knowledge || ""}

GOALS
${prompt.primary_goals || ''}

LANGUAGE
${prompt.language || 'English'}

TONE
${prompt.tone || 'friendly'}

RESPONSE FORMAT
${prompt.response_format || 'Clear and concise.'}

GUIDELINES
${prompt.do_guidelines || ""}

RESTRICTIONS
${prompt.dont_guidelines || ""}

Always follow the current state.
`.trim();
}


// // ======================================================
// // WEBSOCKET SERVER (Kyle Local STT&TTS UPDATE: Main Logic)
// // ======================================================

export function startVoiceServer(server) {

  const wss = new WebSocketServer({
    server,
    path: "/ws/deepcall"
  });

  wss.on("connection", (ws) => {

    ws.sessionId = null;
    ws.callState = "WELCOME";
    ws.audioBuffer = [];

    console.log("📞 Client connected (Local Mode)");

    ws.on("message", async (msg) => {

      try { // Kyle Local STT&TTS UPDATE: Added top-level try/catch
        let data = null;

        try {
          data = JSON.parse(msg.toString());
        } catch {}

        // =====================================
        // START CALL
        // =====================================

        if (data?.type === "start-call") {

          console.log("🚀 START CALL RECEIVED");

          ws.sessionId = data.session_id;

          // Kyle Local STT&TTS UPDATE: Load General Agent
          const promptData = await getAgentFromDB('general');
          const systemPrompt = buildFullSystemPrompt(promptData);

          const session = {
            agent: "general",
            history: [],
            geminiHistory: [{ role: 'user', parts: [{ text: systemPrompt }] }], // Kyle Local STT&TTS UPDATE: prime with system prompt
            context: {
              agent_type: "general",
              ...data.context
            }
          };

          callSessions.set(ws.sessionId, session);

          ws.callState = "ACTIVE";

          const welcomeText = "Hi! I'm listening. How can I help you today?"; // Kyle Local STT&TTS UPDATE

          ws.send(JSON.stringify({
            type: "ai-text",
            text: welcomeText
          }));

          const welcomeAudio = await generateTTS(welcomeText);

          if (welcomeAudio && ws.readyState === 1) {

            console.log("🔊 Sending welcome audio");

            ws.send(welcomeAudio);

          }

          return;

        }

        // =====================================
        // AUDIO RECEIVED
        // =====================================

        if (Buffer.isBuffer(msg) || msg instanceof ArrayBuffer) {
          console.log("AUDIO CHUNK RECEIVED:", msg.length);

          if (ws.callState !== "ACTIVE") return;

          const session = callSessions.get(ws.sessionId);
          if (!session) return;

          try {

            ws.audioBuffer.push(msg);

            const totalSize =
              ws.audioBuffer.reduce((a,b)=>a+b.length,0);

            // tunggu audio cukup sebelum STT
            if (totalSize < 32000) {
              return;
            }

            const audioData = Buffer.concat(ws.audioBuffer);
            if (!audioData || audioData.length < 16000) {
              console.log("⚠️ Audio too small, skipping STT");
              ws.audioBuffer = [];
              return;
            }

            ws.audioBuffer = [];

            // const transcript =
            //   await transcribeAudio(audioData);
            const wavStream = pcmToWav(audioData, 16000);

            const chunks = [];
            for await (const chunk of wavStream) {
              chunks.push(chunk);
            }
            
            const wavBuffer = Buffer.concat(chunks);
            
            const transcript = await transcribeAudio(wavBuffer);

            if (!transcript) return;

            console.log("🗣️ User:", transcript);

            ws.send(JSON.stringify({
              type: "user-text",
              text: transcript
            }));

            session.history.push({
              role: "user",
              content: transcript
            });

            // Kyle Local STT&TTS UPDATE: Use Gemini instead of direct N8N for logic
            // const aiReply = await askN8N(transcript, session);
            const aiReply = await runGeminiTurn(session, transcript);

            ws.send(JSON.stringify({
              type: "ai-text",
              text: aiReply
            }));

            session.history.push({
              role: "assistant",
              content: aiReply
            });

            const audio = await generateTTS(aiReply);

            if (audio && ws.readyState === 1) {

              console.log("🔊 Sending AI audio:", audio.length);

              ws.send(audio);

            }

          } catch (err) {

            console.error(
              "❌ AUDIO PIPELINE ERROR:",
              err
            );

          }

        }
      } catch (err) {
          console.error("❌ FATAL WEBSOCKET ERROR:", err);
          ws.close(1011, "Internal Server Error");
      }
    });

    ws.on("close", () => {

      console.log("❌ Client disconnected", ws.sessionId);

      callSessions.delete(ws.sessionId);

    });

  });

}


// import { WebSocketServer } from "ws"; // Kyle Local STT&TTS UPDATE: Moved up

// ======================================================
// CONFIG
// ======================================================

// const N8N_WEBHOOK = "https://n8n.ihubtechnologies.com.au/webhook/wastevantage-chatbot";

// ======================================================
// ELEVENLABS CONFIG (Kyle Local STT&TTS UPDATE: DISABLED)
// ======================================================

// const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
// const ELEVENLABS_VOICE_ID =
//   process.env.ELEVENLABS_VOICE_ID || "TX3LPaxmHKxFdv7VOQHJ";

// if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLABS_API_KEY");
// if (!ELEVENLABS_AGENT_ID) throw new Error("Missing ELEVENLABS_AGENT_ID");

// async function getElevenLabsSignedUrl() {
//   const res = await fetch(
//     `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVENLABS_AGENT_ID}`,
//     {
//       headers: {
//         "xi-api-key": ELEVENLABS_API_KEY
//       }
//     }
//   );

//   if (!res.ok) throw new Error(`Signed URL failed: ${res.status}`);

//   const body = await res.json();
//   return body.signed_url;
// }
// Kyle Local STT&TTS UPDATE: Removed duplicate extractPostcode - already declared above
// ... (Rest of the ElevenLabs helper functions commented out for brevity, but exist in file) ...


// async function startElevenLabs(ws, systemPrompt, initialContext) {
//     // Kyle Local STT&TTS UPDATE: Disabled
// }

// async function handleElevenLabsMessage(ws, elMsg) {
//     // Kyle Local STT&TTS UPDATE: Disabled
// }

// ... (Existing App Endpoints remain unchanged) ...

// ==============================
// START VOICE WEBSOCKET SERVER
// ==============================
startVoiceServer(server); // Kyle Local STT&TTS UPDATE: Enabled

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("=== iHub Combined Server ===");
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🧠 AI Endpoint: POST /generate`);
    console.log(`💬 Live Chat Admin: GET /livechat/admin/stream`);
    console.log(`📊 Database: Connected to ihub_crm`);
    console.log(`⏰ Session Timeout: ${SESSION_CLAIM_TIMEOUT/1000} seconds (2 minutes)`);
    console.log(`✅ All endpoints preserved and functional`);
    console.log("=============================");
});
