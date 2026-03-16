import wav from "wav"; // Kyle Local STT&TTS UPDATE: Uncommented
import { PassThrough } from "stream"; // Kyle Local STT&TTS UPDATE: Uncommented
import { WebSocketServer } from "ws"; // Kyle Local STT&TTS UPDATE: Uncommented
import FormData from "form-data"; // Kyle STT FIX: needed for multipart/form-data upload to Whisper

// Kyle Local STT&TTS UPDATE: Google Gemini Imports
import { GoogleGenerativeAI } from "@google/generative-ai";
import { spawn } from "child_process";

// ======================================================
// CONFIG (Kyle Local STT&TTS UPDATE)
// ======================================================

const WHISPER_URL = "https://voice.skendern8n.com/stt"; // Kyle Local STT&TTS UPDATE: Updated URL
// const N8N_WEBHOOK = "https://n8n.ihubtechnologies.com.au/webhook/wastevantage-chatbot"; // Declared later
const KOKORO_URL = "https://voice.skendern8n.com/tts"; // Kyle Local STT&TTS UPDATE: Updated URL

// Kyle Local STT&TTS UPDATE: Gemini Config
const GEMINI_API_KEY = "AIzaSyCj4JUMusqvsqYaPTBigR7UHJ-urWjImb8";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });



// ======================================================
// AI CALL SESSIONS
// ======================================================

const callSessions = new Map();

// ======================================================
// WEBSOCKET CONNECTION
// ======================================================

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

// ======================================================
// STT
// ======================================================


function pcmToWav(pcmBuffer, sampleRate = 16000) {
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

async function transcribeAudio(buffer) {
  try {
    const form = new FormData();
    // Pastikan buffer adalah Buffer Node.js
    form.append("audio_file", buffer, {
      filename: "audio.wav",
      contentType: "audio/wav"
    });

    const res = await axios.post(WHISPER_URL, form, {
      headers: { ...form.getHeaders() },
      timeout: 15000 
    });

    return res.data || null;
  } catch (err) {
    // Menangani error 502 dari Cloudflare/Host
    if (err.response?.status === 502) {
      console.error("❌ STT SERVER OFFLINE: Host voice.skendern8n.com tidak merespons (Bad Gateway).");
    } else {
      console.error("❌ STT ERROR:", err.message);
    }
    return null;
  }
}

// ======================================================
// AI (N8N)
// ======================================================

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

// ======================================================
// TTS
// ======================================================

// function pcmToWav(pcmBuffer, sampleRate = 24000) {

//   const stream = new PassThrough();

//   const writer = new wav.Writer({
//     channels: 1,
//     sampleRate: sampleRate,
//     bitDepth: 16
//   });

//   writer.pipe(stream);

//   writer.write(pcmBuffer);
//   writer.end();

//   return stream;
// }

// Read the sample rate Kokoro actually used from the WAV fmt chunk.
// WAV format: "RIFF"(4) + fileSize(4) + "WAVE"(4) + "fmt "(4) + chunkSize(4)
// + audioFormat(2) + numChannels(2) + sampleRate(4) + ...
// function readWavSampleRate(wavBuffer) {
//   try {
//     // fmt chunk starts at byte 20, sample rate is at byte 24
//     return wavBuffer.readUInt32LE(24);
//   } catch {
//     return null;
//   }
// }

function readWavSampleRate(buf) {
  if (
    buf.slice(0,4).toString() !== "RIFF" ||
    buf.slice(8,12).toString() !== "WAVE"
  ) {
    return null;
  }

  return buf.readUInt32LE(24);
}



async function generateTTS(text) {
  try {
    console.log("[DEBUG] Generating TTS and converting to Raw PCM...");

    const res = await axios.post(
      KOKORO_URL,
      {
        input: text,
        voice: "af_sky",
        model: "kokoro"
      },
      {
        headers: { "Content-Type": "application/json" },
        responseType: "arraybuffer"
      }
    );

    const inputBuffer = Buffer.from(res.data);
    
    // Gunakan FFmpeg untuk konversi ke Raw PCM 16-bit Little Endian
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-i", "pipe:0",          // Ambil input dari Kokoro (apapun formatnya: MP3/WAV/PCM)
        "-f", "s16le",           // Output format: Signed 16-bit Little Endian (Mentah)
        "-acodec", "pcm_s16le",  // Codec PCM
        "-ar", "48000",          // Paksa sample rate ke 48kHz
        "-ac", "1",              // Paksa ke Mono
        "pipe:1"                 // Kirim hasil ke stdout
      ]);

      let pcmChunks = [];
      ffmpeg.stdout.on("data", (chunk) => pcmChunks.push(chunk));
      ffmpeg.stderr.on("data", (data) => { /* debug ffmpeg jika perlu: console.log(data.toString()) */ });

      ffmpeg.on("close", (code) => {
        if (code === 0) {
          const finalPcm = Buffer.concat(pcmChunks);
          console.log(`✅ [DEBUG] TTS PCM Ready: ${finalPcm.length} bytes at 48000Hz`);
          resolve(finalPcm);
        } else {
          console.error("[DEBUG] FFmpeg failed with code", code);
          reject(new Error("FFmpeg conversion failed"));
        }
      });

      ffmpeg.stdin.write(inputBuffer);
      ffmpeg.stdin.end();
    });

  } catch (err) {
    console.error("❌ [DEBUG] TTS FAILED:", err.message);
    return null;
  }
}

// async function generateTTS(text) {

//   try {

//     console.log("[DEBUG] Attempting to generate TTS audio...");

//     const KOKORO_SAMPLE_RATE = 48000;

//     const res = await axios.post(
//       KOKORO_URL,
//       {
//         input: text,
//         voice: "af_sky",
//         model: "kokoro"
//       },
//       {
//         headers: {
//           "Content-Type": "application/json"
//         },
//         responseType: "arraybuffer"
//       }
//     );

//     console.log("[DEBUG] TTS response content-type:", res.headers["content-type"]);
//     let wavBuffer = Buffer.from(res.data);
//     console.log("[DEBUG] TTS raw response first 12 bytes:", wavBuffer.slice(0, 12).toString("hex"), "| as ASCII:", wavBuffer.slice(0, 4).toString());
//     let detectedRate = readWavSampleRate(wavBuffer);

//     // Kokoro may return raw PCM without a WAV header — wrap it if needed
//     if (!detectedRate) {
//       console.log("[DEBUG] TTS returned raw PCM (no WAV header). Wrapping with WAV header at", KOKORO_SAMPLE_RATE, "Hz");
//       const chunks = [];
//       const wavStream = pcmToWav(wavBuffer, KOKORO_SAMPLE_RATE);
//       for await (const chunk of wavStream) {
//         chunks.push(chunk);
//       }
//       wavBuffer = Buffer.concat(chunks);
//       detectedRate = readWavSampleRate(wavBuffer);
//     }

//     console.log(`[DEBUG] TTS audio ready. Bytes: ${wavBuffer.length}, Sample rate: ${detectedRate ?? "unknown"}Hz`);

//     return wavBuffer;

//   } catch (err) {

//     console.error(
//       "❌ [DEBUG] TTS GENERATION FAILED:",
//       err.response?.status,
//       err.response?.data ? new TextDecoder().decode(err.response.data) : err.message
//     );

//     return null;

//   }

// }

// ======================================================
// GEMINI BRAIN (Kyle Local STT&TTS UPDATE: Added)
// ======================================================

async function getAgentFromDB(agentType) { 
  try {
    console.log(`[DEBUG] Attempting to get agent '${agentType}' from DB...`);
    const rows = await queryAsync(
      `SELECT * FROM chatbot_prompts WHERE agent_type = ? ORDER BY id DESC LIMIT 1`,
      [agentType]
    );
    if (rows.length) {
        console.log(`[DEBUG] Found agent data for '${agentType}'.`);
        return rows[0];
    }
    console.log(`[DEBUG] No agent data found for '${agentType}'.`);
    return null;
  } catch (err) {
    console.error("[DEBUG] DB Error getting agent:", err);
    return null;
  }
}

async function runGeminiTurn(session, userText) {
  // Kyle Gemini FIX: Create a model instance per-turn that includes the
  // system prompt via systemInstruction (the correct Gemini API approach).
  // Previously the system prompt was incorrectly jammed into geminiHistory
  // as a bare user message with no model reply, which caused API errors.
  const sessionModel = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: session.geminiSystemPrompt || "You are a helpful assistant."
  });

  const chat = sessionModel.startChat({
    history: session.geminiHistory || [],
    generationConfig: {
      maxOutputTokens: 200,
    },
  });

  try {
    const result = await chat.sendMessage(userText);
    const response = await result.response;
    const text = response.text();

    // Update history (only real user/model turns — NOT the system prompt)
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

// Kyle Local STT&TTS UPDATE: Added buildFullSystemPrompt for voice server
function buildFullSystemPromptLocal(prompt) {
  if (!prompt) {
      console.log("[DEBUG] No prompt data provided, using default prompt.");
      return "You are a helpful assistant.";
  }
  console.log("[DEBUG] Building full system prompt from DB data.");
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


// ======================================================
// WEBSOCKET SERVER (Kyle Local STT&TTS UPDATE: Main Logic)
// ======================================================

export function startVoiceServer(server) {

  const wss = new WebSocketServer({
    server,
    path: "/ws/deepcall"
  });

  wss.on("connection", (ws) => {

    ws.sessionId = null;
    ws.callState = "WELCOME";
    ws.audioBuffer = [];
    ws.isProcessing = false; // lock to prevent concurrent STT→Gemini→TTS pipelines

    console.log("📞 Client connected (Local Mode)");

    // Kyle Local STT&TTS UPDATE: Diagnostic Test
    try {
        console.log("[DIAGNOSTIC] Sending 'server-ready' message immediately upon connection.");
        ws.send(JSON.stringify({ type: "server-ready" }));
    } catch (e) {
        console.error("[DIAGNOSTIC] Failed to send 'server-ready' message:", e);
    }


    ws.on("message", async (msg) => {

      try {
        let data = null;

        try {
          data = JSON.parse(msg.toString());
          console.log("[DIAGNOSTIC] Received message from client:", data.type);
        } catch {}

        // =====================================
        // START CALL
        // =====================================

        if (data?.type === "start-call") {

          console.log("🚀 [DEBUG] START-CALL event received. Beginning setup...");

          ws.sessionId = data.session_id;

          // Kyle Local STT&TTS UPDATE: Load General Agent
          const promptData = await getAgentFromDB('general');
          const systemPrompt = buildFullSystemPromptLocal(promptData);

          const session = {
            agent: "general",
            history: [],
            geminiHistory: [],           // Kyle Gemini FIX: start with empty history
            geminiSystemPrompt: systemPrompt, // system prompt passed via systemInstruction, not history
            context: {
              agent_type: "general",
              ...data.context
            }
          };

          callSessions.set(ws.sessionId, session);
          console.log("[DEBUG] Session created and stored.");

          // Don't set ACTIVE yet — prevent mic audio from being processed
          // while we generate and send the welcome TTS
          ws.callState = "WELCOME";

          const welcomeText = "Hi! I'm listening. How can I help you today?";

          console.log("[DEBUG] Sending welcome text to client...");
          ws.send(JSON.stringify({
            type: "ai-text",
            text: welcomeText
          }));
          console.log("[DEBUG] Welcome text sent.");

          const welcomeAudio = await generateTTS(welcomeText);

          if (welcomeAudio && ws.readyState === 1) {

            console.log("[DEBUG] Sending welcome audio to client...");
            ws.send(JSON.stringify({ type: "audio-start" }));
            ws.send(welcomeAudio);
            ws.send(JSON.stringify({ type: "audio-end" }));
            console.log("[DEBUG] Welcome audio sent.");
            ws.send(JSON.stringify({ type: "call-ready" }));

          } else {
             console.log("❌ [DEBUG] Failed to send welcome audio. TTS might have failed or WebSocket closed.");
          }

          // NOW accept mic audio
          ws.callState = "ACTIVE";
          console.log("✅ [DEBUG] START-CALL setup complete. Mic now active.");
          return;

        }

        // =====================================
        // AUDIO RECEIVED
        // =====================================

        if (Buffer.isBuffer(msg) || msg instanceof ArrayBuffer) {

          if (ws.callState !== "ACTIVE") return;

          const session = callSessions.get(ws.sessionId);
          if (!session) return;

          try {

            // ws.audioBuffer.push(msg);
            ws.audioBuffer.push(Buffer.from(msg));

            const totalSize =
              ws.audioBuffer.reduce((a,b)=>a+b.length,0);

            // wait until enough audio has accumulated before sending to STT
            if (totalSize < 16000) {
              return;
            }

            // if (totalSize < 8000) {
            //   return;
            // }

            // drop chunk if a pipeline is already running — prevents duplicate TTS
            if (ws.isProcessing) {
              ws.audioBuffer = [];
              return;
            }

            // const audioData = Buffer.concat(ws.audioBuffer);
            // const floatData = new Float32Array(
            //   Buffer.concat(ws.audioBuffer).buffer
            // );
            // const raw = Buffer.concat(ws.audioBuffer);

            // const floatData = new Float32Array(
            //   raw.buffer,
            //   raw.byteOffset,
            //   raw.byteLength / 4
            // );
            // console.log("RAW BYTES:", raw.length);
            
            // const audioData = float32ToInt16(floatData);
            // if (!audioData || audioData.length < 8000) {
            //   console.log("⚠️ Audio too small, skipping STT");
            //   ws.audioBuffer = [];
            //   return;
            // }
            const raw = Buffer.concat(ws.audioBuffer);

            console.log("RAW BYTES:", raw.length);
            
            // mic sudah mengirim INT16 PCM
            const audioData = raw;
            
            // if (!audioData || audioData.length < 16000) {
            //   console.log("⚠️ Waiting for more audio...");
            //   return;
            // }

            ws.audioBuffer = [];
            ws.isProcessing = true;

            const wavStream = pcmToWav(audioData, 16000);

            const chunks = [];
            for await (const chunk of wavStream) {
              chunks.push(chunk);
            }
            
            const wavBuffer = Buffer.concat(chunks);
            
            const transcript = await transcribeAudio(wavBuffer);

            if (!transcript) {
              ws.isProcessing = false;
              return;
            }

            console.log("🗣️ User:", transcript);

            ws.send(JSON.stringify({
              type: "user-text",
              text: transcript
            }));

            session.history.push({
              role: "user",
              content: transcript
            });

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
              ws.send(JSON.stringify({ type: "audio-start" }));
              ws.send(audio);
              ws.send(JSON.stringify({ type: "audio-end" }));

            }

          } catch (err) {

            console.error(
              "❌ AUDIO PIPELINE ERROR:",
              err
            );

          } finally {

            ws.isProcessing = false; // always release lock so next turn can proceed

          }

        }
      } catch (err) {
          console.error("❌ [DEBUG] FATAL WEBSOCKET ERROR:", err.message, err.stack);
          ws.close(1011, "Internal Server Error");
      }
    });

    ws.on("close", (code, reason) => {

      console.log(`❌ Client disconnected (code: ${code}, reason: ${reason ? reason.toString() : 'No reason given'})`, ws.sessionId);

      callSessions.delete(ws.sessionId);

    });

  });

}


// import { WebSocketServer } from "ws"; // Kyle Local STT&TTS UPDATE: Moved up

// ======================================================
// CONFIG
// ======================================================

const N8N_WEBHOOK = "https://n8n.ihubtechnologies.com.au/webhook/wastevantage-chatbot";

// ======================================================
// ELEVENLABS CONFIG (Kyle Local STT&TTS UPDATE: DISABLED)
// ======================================================

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "TX3LPaxmHKxFdv7VOQHJ";

// if (!ELEVENLABS_API_KEY) throw new Error("Missing ELEVENLABS_API_KEY");
// if (!ELEVENLABS_AGENT_ID) throw new Error("Missing ELEVENLABS_AGENT_ID");

async function getElevenLabsSignedUrl() {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY
      }
    }
  );

  if (!res.ok) throw new Error(`Signed URL failed: ${res.status}`);

  const body = await res.json();
  return body.signed_url;
}

// Kyle Local STT&TTS UPDATE: Duplicate declarations below - commented out (already declared in local block above)

// const extractPostcode = (text) => {
//   if (!text) return null;
//   const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
//   const numericMatch = clean.match(/\b\d{4}\b/);
//   if (numericMatch) return numericMatch[0];
//   const wordMap = { zero:"0",one:"1",two:"2",three:"3",four:"4",five:"5",six:"6",seven:"7",eight:"8",nine:"9" };
//   const words = clean.split(/\s+/);
//   let digits = "";
//   for (let w of words) { if (wordMap[w]) digits += wordMap[w]; }
//   if (digits.length === 4) return digits;
//   return null;
// };

// function shouldSwitchToSales(text) {
//   if (!text) return false;
//   const lower = text.toLowerCase();
//   const triggers = ["order","i want","i need","book","hire","get a bin"];
//   return triggers.some(t => lower.includes(t));
// }

// const extractDeliveryDate = (text) => {
//   if (!text) return null;
//   const match = text.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i);
//   return match ? match[1] : null;
// };

// const extractPickupDate = (text) => {
//   if (!text) return null;
//   const match = text.match(/\b(pickup|pick up|collection)\s+(on\s+)?(\d{4}-\d{2}-\d{2}|\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i);
//   return match ? match[3] : null;
// };

// Kyle Local STT&TTS UPDATE: Old ElevenLabs WSS disabled - using startVoiceServer instead
// const wss = new WebSocketServer({
//   server,
//   path: "/ws/deepcall"
// });

// ======================================================
// AI CALL SESSIONS
// ======================================================

// Kyle Local STT&TTS UPDATE: Duplicate declarations below - commented out (already declared in local block above)
// const callSessions = new Map();

// Kyle Local STT&TTS UPDATE: summarizeConversation already declared above
// async function summarizeConversation(sessionId) { ... }

// Kyle Local STT&TTS UPDATE: insertLearningQueue already declared above  
// async function insertLearningQueue({ sessionId, question, answer }) { ... }

async function speakWelcome(text) {
  const format = "pcm_16000";

  const url = `https://api.elevenlabs.io/v1/text-to-speech/TX3LPaxmHKxFdv7VOQHJ/stream?output_format=${format}`;

  try {
    const res = await axios({
      method: "POST",
      url: url,
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/lpcm"
      },
      data: {
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.82,
          similarity_boost: 0.78,
          speed: 1.15,
          style: 0.0
        }
      },
      responseType: "arraybuffer"
    });

    let buffer = Buffer.from(res.data);

    const firstBytesText = buffer.slice(0, 4).toString();

    if (firstBytesText.startsWith("ID3")) {
      throw new Error(
        "API tetap mengirim MP3, periksa konfigurasi ElevenLabs!"
      );
    }

    if (buffer.length % 2 !== 0) {
      buffer = buffer.slice(0, buffer.length - 1);
    }

    return buffer;
  } catch (err) {
    console.error("❌ TTS ERROR:", err.message);
    throw err;
  }
}

process.on("unhandledRejection", (err) => {
  console.error("🔥 UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT EXCEPTION:", err);
});


function buildFullSystemPrompt(prompt) {
  return `
You are ${prompt.identity}.

ROLE
${prompt.role_description}

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
${prompt.primary_goals}

LANGUAGE
${prompt.language}

TONE
${prompt.tone}

RESPONSE FORMAT
${prompt.response_format}

GUIDELINES
${prompt.do_guidelines || ""}

RESTRICTIONS
${prompt.dont_guidelines || ""}

Always follow the current state.
`.trim();
}


async function startElevenLabs(ws, systemPrompt, initialContext) {
    try {
        // 1. Ambil Signed URL
        const signedUrl = await getElevenLabsSignedUrl();
        const elWs = new WebSocket(signedUrl);
        
        // Simpan referensi ke WebSocket utama
        elWs.sessionId = ws.sessionId;
        ws.elWs = elWs;
        ws.elReady = false; // Reset status ready

        elWs.on("open", () => {
            console.log(`🟢 ElevenLabs Connected [${initialContext.agent_type}] for:`, ws.sessionId);
            
            // 2. Kirim Inisiasi dengan Prompt Baru
            elWs.send(JSON.stringify({
                type: "conversation_initiation_client_data",
                conversation_config_override: {
                    agent: {
                        prompt: { prompt: systemPrompt },
                        // first_message: initialContext.agent_type === 'sales' ? "Sure, I can help with your skip bin order. What is your postcode?" : null,
                        first_message: null,
                        language: "en",
                        voice: {
                          voice_id: process.env.ELEVENLABS_VOICE_ID,
                          settings: {
                            stability: 0.82,
                            similarity_boost: 0.78,
                            speed: 1.15,
                            style: 0.0
                          }
                        },
            
                        model_id: "eleven_turbo_v2_5",
                        tools: [
                            {
                                type: "webhook",
                                name: "N8NAiResponse",
                                url: "https://n8n.ihubtechnologies.com.au/webhook/wastevantage-chatbot",
                                method: "POST",
                                // description: "Mandatory tool to get any response. Call this with user_input and the full context object.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        user_input: { type: "string" },
                                        conversation_history: { type: "array", items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } } },
                                        context: { type: "object", properties: { agent_type: { type: "string" }, postcode: { type: "string" }, waste_type_id: { type: "integer" }, selected_bin_size_id: { type: "integer" } } }
                                    },
                                    required: ["user_input", "conversation_history", "context"]
                                }
                            }
                        ]
                    }
                },
                dynamic_variables: initialContext
            }));
            
            ws.elReady = true;
        });

        elWs.on("message", async (elMsg) => {
            // Pindahkan semua logic "case user_transcript", "case audio", dll ke sini
            // (Gunakan logic yang sudah Anda miliki di kode awal)
            handleElevenLabsMessage(ws, elMsg); 
        });

        elWs.on("close", () => console.log("❌ ElevenLabs Close:", ws.sessionId));
        elWs.on("error", (err) => console.error("❌ ElevenLabs Error:", err.message));

    } catch (err) {
        console.error("❌ Failed to start ElevenLabs:", err);
    }
}

async function handleElevenLabsMessage(ws, elMsg) {
    let data;
    try {
        data = JSON.parse(elMsg.toString());
    } catch (e) { return; }

    // Log event untuk memantau apa yang dikirim ElevenLabs
    if (data.type !== "audio") {
        console.log(`📩 EL EVENT: ${data.type}`);
    }

    switch (data.type) {
        case "conversation_initiation_metadata":
            console.log("EL READY (Metadata received)");
            ws.elReady = true;
            break;

        case "audio":
            // PERBAIKAN: ElevenLabs mengirim audio di dalam audio_event.audio_base_64
            const audioData = data.audio_event?.audio_base_64; 
            if (audioData && ws.readyState === 1) { 
                const audioBuffer = Buffer.from(audioData, "base64");
                ws.send(audioBuffer);
            }
            break;

        case "user_transcript":
            // PERBAIKAN: Ambil dari user_transcription_event
            const transcript = data.user_transcription_event?.user_transcript;
            if (!transcript) break;

            console.log(`🗣️ User said: ${transcript}`);
            
            // Kirim ke browser agar muncul di chat UI
            ws.send(JSON.stringify({ type: "user-text", text: transcript }));

            // LOGIKA SWITCHING
            if (shouldSwitchToSales(transcript)) {
                const session = callSessions.get(ws.sessionId);
                if (session && session.agent !== 'sales' && !session.agentLocked) {
                    console.log("🔁 SWITCHING DETECTED: general → sales");
                    // handleAgentSwitch(ws, 'sales');
                }
            }
            break;

        case "agent_response":
            // PERBAIKAN: Ambil dari agent_response_event
            const aiText = data.agent_response_event?.agent_response;
            if (!aiText) break;

            console.log(`🤖 Agent: ${aiText}`);
            ws.send(JSON.stringify({ type: "ai-text", text: aiText }));
            break;

        case "ping":
            if (ws.elWs && ws.elWs.readyState === 1) {
                ws.elWs.send(JSON.stringify({ 
                    type: "pong", 
                    event_id: data.ping_event?.event_id 
                }));
            }
            break;
    }
}

// async function handleAgentSwitch(ws, newAgentType) {

//   const session = callSessions.get(ws.sessionId);
//   if (!session) return;

//   console.log(`🔌 Switching to ${newAgentType} Agent...`);

//   session.agentLocked = true;

//   if (ws.elWs) {
//     try { ws.elWs.close(); } catch(e) {}
//     ws.elWs = null;
//   }

//   const rows = await queryAsync(
//     `SELECT * FROM chatbot_prompts
//      WHERE agent_type = ?
//      ORDER BY id DESC
//      LIMIT 1`,
//     [newAgentType]
//   );

//   if (!rows.length) return;

//   const promptData = rows[0];

//   const fullSystemPrompt = buildFullSystemPrompt(promptData);

//   session.agent = newAgentType;
//   session.systemPrompt = fullSystemPrompt;
//   session.context.agent_type = newAgentType;

//   ws.send(JSON.stringify({
//     type: "ai-text",
//     text: "Connecting you with our sales assistant Max..."
//   }));

//   await startElevenLabs(ws, fullSystemPrompt, session.context);
// }

// async function handleAgentSwitch(ws, newAgentType) {

//   const session = callSessions.get(ws.sessionId);
//   if (!session) return;

//   console.log(`🔁 Switching to ${newAgentType} agent`);

//   session.agent = newAgentType;
//   session.context.agent_type = newAgentType;

//   // kirim update ke ElevenLabs TANPA restart
//   if (ws.elWs && ws.elWs.readyState === 1) {

//     ws.elWs.send(JSON.stringify({
//       type: "dynamic_variables",
//       dynamic_variables: {
//         ...session.context
//       }
//     }));

//     console.log("✅ Agent switched via dynamic variables");
//   }

//   ws.send(JSON.stringify({
//     type: "ai-text",
//     text: "Hi, I'm Max. I'll help your request"
//   }));
// }

async function handleAgentSwitch(ws, newAgentType) {

  const session = callSessions.get(ws.sessionId);
  if (!session) return;

  console.log(`🔁 Switching agent → ${newAgentType}`);

  const rows = await queryAsync(
    `
    SELECT *
    FROM chatbot_prompts
    WHERE agent_type = ?
    ORDER BY id DESC
    LIMIT 1
    `,
    [newAgentType]
  );

  if (!rows.length) return;

  const promptData = rows[0];

  const newPrompt = buildFullSystemPrompt(promptData);

  session.agent = newAgentType;
  session.promptId = promptData.id;
  session.activePrompt = newPrompt;
  session.context.agent_type = newAgentType;

  ws.elWs.send(JSON.stringify({
    type: "dynamic_variables",
    dynamic_variables: {
      ...session.context,
      system_prompt: newPrompt
    }
  }));

  console.log("✅ Prompt updated dynamically");

}
