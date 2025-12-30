const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const { v4: uuid } = require("uuid");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

const app = express();

/* ============================
   BODY PARSER – WAJIB PALING ATAS
============================= */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);

        const allowedOrigins = [
        'https://livechat-backend-3sft.onrender.com',
        'https://n8n.ihubtechnologies.com.au',
        'https://demo-crm.ihubtechnologies.com.au',
        'https://ihubs-chat.infinityfreeapp.com'
        ];

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log("❌ CORS blocked:", origin);
            callback(null, false);   // ⛔ JANGAN throw Error
        }
    },
    credentials: true,
    methods: ['GET','POST','OPTIONS','PUT','DELETE','PATCH'],
    allowedHeaders: ['Content-Type','Authorization','X-Requested-With', 'x-debug']
}));

// Manual CORS headers for extra safety
app.use((req,res,next)=>{
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

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
    keepAliveInitialDelay: 0
});

// Specific OPTIONS handler for problematic routes
app.options('/ai/chat', (req, res) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Debug, X-Source');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.status(200).end();
});

app.options('/n8n/get-prompt', (req, res) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.status(200).end();
});




// -----------------------------------------------------
// LIVE CHAT IN-MEMORY STORE
// -----------------------------------------------------
const sessions = {};
const adminClients = [];
const clientConnections = {};
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes for inactive sessions
const SESSION_CLAIM_TIMEOUT = 2 * 60 * 1000; // 2 minutes for unclaimed sessions

// -----------------------------------------------------
// SSE HELPER FUNCTIONS
// -----------------------------------------------------
function pushToClients(sessionId, message) {
    if (!clientConnections[sessionId]) return;
    
    clientConnections[sessionId] = clientConnections[sessionId].filter(res => {
        try {
            res.write(`data: ${JSON.stringify(message)}\n\n`);
            return true;
        } catch (error) {
            console.log('Removing dead client connection');
            return false;
        }
    });
}

function notifyAdmins(payload) {
    console.log(`🔔 Notifying ${adminClients.length} admins:`, payload.type);
    
    for (let i = adminClients.length - 1; i >= 0; i--) {
        const res = adminClients[i];
        if (res.writableEnded || res.destroyed || !res.writable) {
            adminClients.splice(i, 1);
            console.log('Removed dead admin connection');
        }
    }
    
    let sentCount = 0;
    adminClients.forEach((res, index) => {
        try {
            if (res.writable && !res.writableEnded) {
                const data = `data: ${JSON.stringify(payload)}\n\n`;
                res.write(data);
                sentCount++;
                console.log(`✅ Sent to admin ${index}`);
            }
        } catch (error) {
            console.log(`❌ Failed to send to admin ${index}:`, error.message);
        }
    });
    
    console.log(`📊 Successfully sent to ${sentCount}/${adminClients.length} admins`);
}



admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function sendIncomingCall(agent_type, session_id) {
  db.query("SELECT fcm_token FROM admin_push_tokens", async (_, rows) => {
    for (const row of rows) {
      await admin.messaging().send({
        token: row.fcm_token,
        notification: {
          title: "📞 Incoming Call",
          body: `There's customer want to connect with ${agent_type}`
        },
        data: { session_id }
      });
    }
  });
}


// -----------------------------------------------------
// SESSION CLEANUP - UPDATED WITH 2-MINUTE TIMEOUT
// -----------------------------------------------------
function cleanupExpiredSessions() {
    const now = Date.now();
    let expiredCount = 0;
    let timeoutCount = 0;
    
    Object.keys(sessions).forEach(sessionId => {
        const session = sessions[sessionId];
        const sessionAge = now - new Date(session.createdAt).getTime();
        
        // Check for 2-minute unclaimed timeout
        if (!session.agentName && sessionAge > SESSION_CLAIM_TIMEOUT) {
            console.log(`⏰ Session timeout (2 minutes): ${sessionId}`);
            
            // Notify client about timeout
            if (clientConnections[sessionId]) {
                clientConnections[sessionId].forEach(clientRes => {
                    try {
                        clientRes.write(`data: ${JSON.stringify({
                            type: 'timeout',
                            message: "No agents were available to connect with you within 2 minutes. Please try again later or leave a message.",
                            sessionId: sessionId
                        })}\n\n`);
                    } catch (error) {
                        console.log('Failed to send timeout to client');
                    }
                });
            }
            
            // Notify admins
            notifyAdmins({
                type: "session_timeout",
                sessionId,
                userName: session.userName,
                reason: "No agent claimed within 2 minutes"
            });
            
            // Mark as timed out (but keep for reference)
            sessions[sessionId].status = 'timed_out';
            sessions[sessionId].timeoutAt = new Date().toISOString();
            timeoutCount++;
            
        } 
        // Check for 30-minute inactive timeout
        else if (sessionAge > SESSION_TIMEOUT) {
            console.log(`Cleaning up expired session: ${sessionId}`);
            
            notifyAdmins({
                type: "session_expired",
                sessionId,
                userName: session.userName
            });
            
            delete sessions[sessionId];
            delete clientConnections[sessionId];
            expiredCount++;
        }
    });
    
    if (expiredCount > 0 || timeoutCount > 0) {
        console.log(`Cleaned up ${expiredCount} expired sessions, ${timeoutCount} timed out sessions`);
    }
}

// Check sessions every 30 seconds
setInterval(cleanupExpiredSessions, 30000);

// Check for sessions approaching timeout (1.5 minutes)
setInterval(() => {
    const now = Date.now();
    const warningThreshold = 1.5 * 60 * 1000; // 1.5 minutes
    
    Object.keys(sessions).forEach(sessionId => {
        const session = sessions[sessionId];
        if (!session.agentName) {
            const sessionAge = now - new Date(session.createdAt).getTime();
            const timeRemaining = SESSION_CLAIM_TIMEOUT - sessionAge;
            
            // Send warning to admins when 30 seconds left
            if (timeRemaining > 0 && timeRemaining <= 30000 && !session.warningSent) {
                console.log(`⚠️ Session ${sessionId} will timeout in ${Math.ceil(timeRemaining/1000)} seconds`);
                
                notifyAdmins({
                    type: "session_warning",
                    sessionId,
                    userName: session.userName,
                    secondsRemaining: Math.ceil(timeRemaining/1000),
                    message: `Session will timeout in ${Math.ceil(timeRemaining/1000)} seconds`
                });
                
                sessions[sessionId].warningSent = true;
            }
        }
    });
}, 10000); // Check every 10 seconds


console.log('='.repeat(50));
console.log('🔍 ENVIRONMENT VARIABLES CHECK');
console.log('='.repeat(50));
console.log('GMAIL_USER:', process.env.GMAIL_USER);
console.log('GMAIL_APP_PASSWORD present:', !!process.env.GMAIL_APP_PASSWORD);
console.log('GMAIL_APP_PASSWORD length:', process.env.GMAIL_APP_PASSWORD ? process.env.GMAIL_APP_PASSWORD.length : 'NULL');
console.log('='.repeat(50));

// Validasi environment variables
if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.error('❌ ERROR: Email credentials missing in .env file!');
    console.error('Make sure .env has:');
    console.error('GMAIL_USER=your_email@gmail.com');
    console.error('GMAIL_APP_PASSWORD=your_16_char_app_password');
    process.exit(1);
}


// Konfigurasi Nodemailer transporter yang TERBUKTI BEKERJA
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

transporter.verify(err => {
    if (err) console.log("❌ Gmail error:", err.message);
    else console.log("✅ Gmail SMTP ready");
});



// Endpoint untuk kirim email
app.post("/api/send-contact-email", (req, res) => {
    const {
        first_name,
        last_name,
        email,
        phone,
        website_url,
        postcode,
        system_type_id,
        inquire_type_id,
        message
    } = req.body;

    if (!first_name || !last_name || !email || !message) {
        return res.status(400).json({ success:false, error:"Missing required fields" });
    }

    const sql = `
        INSERT INTO inquiries
        (first_name,last_name,email,phone,website_url,postcode,message,inquire_type_id,system_type_id,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'new',NOW())
    `;

    db.query(sql, [
        first_name,
        last_name,
        email,
        phone,
        website_url,
        postcode,
        message,
        inquire_type_id,
        system_type_id
    ], (err, result) => {

        if (err) {
            console.error("❌ DB ERROR:", err.sqlMessage || err);
            return res.status(500).json({ success:false, error:"Database insert failed" });
        }

        const mail = {
            from: `"iHub Chat Widget" <${process.env.GMAIL_USER}>`,
            to: "shenluy@gmail.com",
            replyTo: email,
            subject: `📩 Inquiry IHUB CRM - ${first_name} ${last_name}`,
            text: `
                    First Name: ${first_name}
                    Last Name : ${last_name}
                    Email     : ${email}
                    Phone     : ${phone}
                    Website   : ${website_url}
                    Postcode  : ${postcode}
                    System    : IHUB CRM
                    Inquiry   : Website

                    Message:
                    ${message}
                    `
                    };

        transporter.sendMail(mail, (mailErr) => {
            if (mailErr) {
                console.error("❌ EMAIL ERROR:", mailErr);
                return res.status(500).json({ success:false, error:"Email failed" });
            }

            res.json({ success:true, inquiry_id: result.insertId });
        });
    });
});



app.post("/push/register", (req, res) => {
  const { token } = req.body;

  db.query(
    "INSERT IGNORE INTO admin_push_tokens (fcm_token) VALUES (?)",
    [token]
  );

  res.json({ success: true });
});



// -----------------------------------------------------
// ENHANCED AI CHAT ENDPOINT (WITH FALLBACK HANDLING)
// -----------------------------------------------------
app.post("/ai/chat", async (req, res) => {
    console.log("🎯 AI ENDPOINT Called");
    console.log("📥 FULL REQUEST BODY:", JSON.stringify(req.body, null, 2));

    const startTime = Date.now();

    try {
        const {
            agent_type,
            message = "",
            context = {},
            conversation_id,
            user_email,
            user_name = "Guest"
        } = req.body;

        // ===============================
        // 🔒 AGENT TYPE — SINGLE SOURCE OF TRUTH
        // ===============================
        const VALID_AGENT_TYPES = ["general", "sales", "automation", "support"];
        
        // ONLY read from req.body.agent_type
        let finalAgentType = "general";
        
        if (
            typeof agent_type === "string" &&
            VALID_AGENT_TYPES.includes(agent_type)
        ) {
            finalAgentType = agent_type;
        } else {
            console.warn("⚠️ Invalid or missing agent_type, defaulting to general");
        }
        
        console.log("🔒 LOCKED agent_type:", finalAgentType);

        // ===============================
        // DYNAMIC SYSTEM TYPE DETECTION
        // ===============================
        let systemTypeId = null;
        let systemTypeName = null;

        // Fetch all active system types (only IDs 1-6)
        const [systemTypes] = await db.promise().query(
            "SELECT id, name FROM system_types WHERE id BETWEEN 1 AND 6 AND status = 1"
        );

        console.log("📋 Available System Types:", systemTypes);

        // Detect system type from message or context
        const messageLower = message.toLowerCase();
        
        for (const system of systemTypes) {
            const systemNameLower = system.name.toLowerCase();
            
            // Check if system name appears in message
            if (messageLower.includes(systemNameLower)) {
                systemTypeId = system.id;
                systemTypeName = system.name;
                console.log(`✅ Detected system: ${system.name} (ID: ${system.id})`);
                break;
            }
        }

        // If not found in message, check context
        if (!systemTypeId && context?.system_type) {
            const contextSystem = systemTypes.find(s => 
                s.name.toLowerCase() === context.system_type.toLowerCase()
            );
            if (contextSystem) {
                systemTypeId = contextSystem.id;
                systemTypeName = contextSystem.name;
                console.log(`✅ Detected system from context: ${systemTypeName} (ID: ${systemTypeId})`);
            }
        }

        if (!systemTypeId && context?.product) {
            const contextProduct = systemTypes.find(s => 
                s.name.toLowerCase() === context.product.toLowerCase()
            );
            if (contextProduct) {
                systemTypeId = contextProduct.id;
                systemTypeName = contextProduct.name;
                console.log(`✅ Detected system from product: ${systemTypeName} (ID: ${systemTypeId})`);
            }
        }

        // ===============================
        // DYNAMIC CATEGORY DETECTION FROM DATABASE
        // ===============================
        let categoryId = null;
        let categoryName = null;

        // Query database for appropriate category based on agent_type and system_type_id
        if (systemTypeId) {
            // Try to find specific category for this system type and agent
            const [specificCategories] = await db.promise().query(
                `SELECT id, name, display_name 
                 FROM chatbot_categories 
                 WHERE agent_type = ? 
                 AND system_type_id = ? 
                 AND active = 1
                 ORDER BY sort_order ASC
                 LIMIT 1`,
                [finalAgentType, systemTypeId]
            );

            if (specificCategories.length > 0) {
                categoryId = specificCategories[0].id;
                categoryName = specificCategories[0].display_name || specificCategories[0].name;
                console.log(`🎯 Found specific category: ${categoryName} (ID: ${categoryId}) for ${systemTypeName}`);
            } else {
                // Fallback: find general category for this agent type (no system_type_id)
                const [generalCategories] = await db.promise().query(
                    `SELECT id, name, display_name 
                     FROM chatbot_categories 
                     WHERE agent_type = ? 
                     AND system_type_id IS NULL 
                     AND active = 1
                     ORDER BY sort_order ASC
                     LIMIT 1`,
                    [finalAgentType]
                );

                if (generalCategories.length > 0) {
                    categoryId = generalCategories[0].id;
                    categoryName = generalCategories[0].display_name || generalCategories[0].name;
                    console.log(`🎯 Using general category: ${categoryName} (ID: ${categoryId})`);
                }
            }
        } else {
            // No system type detected, use general category
            const [generalCategories] = await db.promise().query(
                `SELECT id, name, display_name 
                 FROM chatbot_categories 
                 WHERE agent_type = ? 
                 AND system_type_id IS NULL 
                 AND active = 1
                 ORDER BY sort_order ASC
                 LIMIT 1`,
                [finalAgentType]
            );

            if (generalCategories.length > 0) {
                categoryId = generalCategories[0].id;
                categoryName = generalCategories[0].display_name || generalCategories[0].name;
                console.log(`🎯 Using general category (no system): ${categoryName} (ID: ${categoryId})`);
            } else {
                // Ultimate fallback: use the first active category for this agent
                const [fallbackCategories] = await db.promise().query(
                    `SELECT id, name, display_name 
                     FROM chatbot_categories 
                     WHERE agent_type = ? 
                     AND active = 1
                     ORDER BY sort_order ASC
                     LIMIT 1`,
                    [finalAgentType]
                );

                if (fallbackCategories.length > 0) {
                    categoryId = fallbackCategories[0].id;
                    categoryName = fallbackCategories[0].display_name || fallbackCategories[0].name;
                    console.log(`⚠️ Using fallback category: ${categoryName} (ID: ${categoryId})`);
                }
            }
        }

        // If still no category found, set defaults based on agent type
        if (!categoryId) {
            const defaultCategoryMap = {
                support: 7, // general_support
                sales: 8,   // pricing_info
                automation: 14, // automation
                general: 18  // general_faq
            };
            categoryId = defaultCategoryMap[finalAgentType] || 7;
            console.log(`⚠️ No category found, using default: ID ${categoryId}`);
        }

        console.log(`✅ Final - Category ID: ${categoryId}, System Type: ${systemTypeName || 'None'}, Agent: ${finalAgentType}`);

        // ===============================
        // 🔍 IMPROVED FAQ SEARCH FROM DATABASE
        // ===============================
        let relevantFaqs = [];
        let faqIdsUsed = [];
        let confidence = 0.7; // Default confidence

        // Only search FAQ table for relevant questions
        if (message.trim().length > 2) {
            try {
                // First, extract key terms from message
                const searchTerms = extractSearchTerms(message);
                console.log(`🔍 Extracted search terms:`, searchTerms);
                
                if (searchTerms.length > 0) {
                    // First, try with category filter and keyword matching
                    const searchQuery = `
                        SELECT 
                            id, 
                            question, 
                            answer, 
                            answer_short,
                            category_id,
                            keywords,
                            confidence_score,
                            priority,
                            usage_count,
                            status
                        FROM chatbot_faq 
                        WHERE status = 'active' 
                        AND category_id = ?
                        AND (
                            ${searchTerms.map(() => `question LIKE ?`).join(' OR ')}
                            OR ${searchTerms.map(() => `keywords LIKE ?`).join(' OR ')}
                            OR ${searchTerms.map(() => `answer LIKE ?`).join(' OR ')}
                            OR MATCH(question, answer) AGAINST (? IN BOOLEAN MODE)
                        )
                        ORDER BY 
                            priority DESC,
                            CASE 
                                WHEN question LIKE ? THEN 10
                                WHEN keywords LIKE ? THEN 9
                                WHEN answer LIKE ? THEN 8
                                ELSE 1
                            END DESC,
                            confidence_score DESC,
                            usage_count DESC
                        LIMIT 5
                    `;

                    // Prepare search parameters
                    const searchParams = [categoryId];
                    
                    // Add LIKE parameters for each search term
                    searchTerms.forEach(term => {
                        searchParams.push(`%${term}%`);  // question LIKE
                    });
                    searchTerms.forEach(term => {
                        searchParams.push(`%${term}%`);  // keywords LIKE
                    });
                    searchTerms.forEach(term => {
                        searchParams.push(`%${term}%`);  // answer LIKE
                    });
                    
                    // Add full message for boolean search
                    const booleanSearch = searchTerms.map(word => `+${word}*`).join(' ');
                    searchParams.push(booleanSearch);
                    
                    // Add exact match parameters for scoring
                    searchParams.push(`%${message}%`);    // exact match in question
                    searchParams.push(`%${message}%`);    // exact match in keywords  
                    searchParams.push(`%${message}%`);    // exact match in answer

                    console.log(`🔍 FAQ Search SQL with params:`, {
                        query: searchQuery.substring(0, 200) + '...',
                        params: searchParams
                    });

                    const [faqRows] = await db.promise().query(searchQuery, searchParams);

                    relevantFaqs = faqRows;
                    faqIdsUsed = faqRows.map(faq => faq.id);

                    // Calculate confidence based on FAQ matches
                    if (faqRows.length > 0) {
                        const avgConfidence = faqRows.reduce((sum, faq) => 
                            sum + parseFloat(faq.confidence_score || 1.0), 0) / faqRows.length;
                        confidence = Math.min(0.95, avgConfidence * 0.9);
                        
                        console.log(`🔍 Found ${faqRows.length} relevant FAQs:`, faqRows.map(f => ({id: f.id, question: f.question.substring(0, 50)})));
                    } else {
                        // No FAQ match, fallback search without category filter but with terms
                        const fallbackQuery = `
                            SELECT 
                                id, 
                                question, 
                                answer, 
                                answer_short,
                                category_id,
                                keywords,
                                confidence_score,
                                priority,
                                usage_count,
                                status
                            FROM chatbot_faq 
                            WHERE status = 'active' 
                            AND (
                                ${searchTerms.map(() => `question LIKE ?`).join(' OR ')}
                                OR ${searchTerms.map(() => `keywords LIKE ?`).join(' OR ')}
                                OR ${searchTerms.map(() => `answer LIKE ?`).join(' OR ')}
                                OR MATCH(question, answer) AGAINST (? IN BOOLEAN MODE)
                            )
                            ORDER BY 
                                priority DESC,
                                confidence_score DESC,
                                usage_count DESC
                            LIMIT 3
                        `;

                        const fallbackParams = [];
                        searchTerms.forEach(term => {
                            fallbackParams.push(`%${term}%`);  // question LIKE
                        });
                        searchTerms.forEach(term => {
                            fallbackParams.push(`%${term}%`);  // keywords LIKE
                        });
                        searchTerms.forEach(term => {
                            fallbackParams.push(`%${term}%`);  // answer LIKE
                        });
                        fallbackParams.push(booleanSearch);

                        const [fallbackRows] = await db.promise().query(fallbackQuery, fallbackParams);

                        if (fallbackRows.length > 0) {
                            relevantFaqs = fallbackRows;
                            faqIdsUsed = fallbackRows.map(faq => faq.id);
                            
                            const avgConfidence = fallbackRows.reduce((sum, faq) => 
                                sum + parseFloat(faq.confidence_score || 1.0), 0) / fallbackRows.length;
                            confidence = Math.min(0.85, avgConfidence * 0.8); // Lower confidence for fallback
                            
                            console.log(`🔍 Found ${fallbackRows.length} fallback FAQs (no category match)`);
                        } else {
                            // Ultimate fallback: search for any Xero-related FAQ
                            const xeroFallbackQuery = `
                                SELECT 
                                    id, 
                                    question, 
                                    answer, 
                                    answer_short,
                                    category_id,
                                    keywords,
                                    confidence_score,
                                    priority,
                                    usage_count,
                                    status
                                FROM chatbot_faq 
                                WHERE status = 'active' 
                                AND (
                                    question LIKE '%xero%'
                                    OR keywords LIKE '%xero%'
                                    OR answer LIKE '%xero%'
                                )
                                ORDER BY priority DESC, usage_count DESC
                                LIMIT 2
                            `;

                            const [xeroRows] = await db.promise().query(xeroFallbackQuery);
                            
                            if (xeroRows.length > 0) {
                                relevantFaqs = xeroRows;
                                faqIdsUsed = xeroRows.map(faq => faq.id);
                                confidence = 0.75; // Medium confidence for keyword-only match
                                
                                console.log(`🔍 Found ${xeroRows.length} Xero-related FAQs`);
                            } else {
                                // No FAQ match, use agent type confidence
                                const confidenceMap = {
                                    sales: 0.85,
                                    support: 0.75,
                                    automation: 0.80,
                                    general: 0.65
                                };
                                confidence = (confidenceMap[finalAgentType] || 0.6) * 0.8;
                                console.log(`⚠️ No FAQs found, using default confidence: ${confidence}`);
                            }
                        }
                    }
                }
            } catch (searchErr) {
                console.error("❌ FAQ search error:", searchErr);
                confidence = 0.6;
            }
        }

    function extractSearchTerms(message) {
        const stopWords = ['i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 
                          'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 
                          'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 
                          'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 
                          'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 
                          'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 
                          'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 
                          'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 
                          'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 
                          'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 
                          'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 
                          'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'please', 'help'];
        
        return message.toLowerCase()
            .split(/[\s,.?!]+/)
            .map(term => term.trim())
            .filter(term => term.length > 2 && !stopWords.includes(term))
            .map(term => {
                // Basic stemming
                return term
                    .replace(/ed$/, '')    // remove 'ed' suffix
                    .replace(/ing$/, '')   // remove 'ing' suffix
                    .replace(/s$/, '');    // remove 's' suffix
            })
            .filter(term => term.length > 2)
            .slice(0, 5); // Limit to 5 most important terms
    }

        app.post("/test-ai-fallback", async (req, res) => {
            const testPayload = {
                agent_type: "sales",
                message: "what are your pricing plans?",
                context: {
                    product: "wastevantage",
                    user_name: "Test User"
                },
                conversation_id: "test_" + Date.now()
            };
            
            console.log("🧪 Testing AI endpoint with fallback...");
            
            // Simulate the endpoint logic
            const response = {
                success: true,
                reply: `Test response: Our WasteVantage pricing starts from $99/month.`,
                agent_type: "sales",
                confidence: 0.85,
                source: "test_fallback",
                timestamp: new Date().toISOString()
            };
            
            res.json(response);
        });

        // ===============================
        // BUILD FAQ-ENHANCED CONTEXT FOR N8N
        // ===============================
        const n8nPayload = {
            agent_type: finalAgentType,
            message,
            context: {
                ...context,
                agent_type: finalAgentType,
                system_type_id: systemTypeId,
                system_type_name: systemTypeName,
                category_id: categoryId,
                category_name: categoryName,
                relevant_faqs: relevantFaqs.map(faq => ({
                    id: faq.id,
                    question: faq.question,
                    answer: faq.answer,
                    answer_short: faq.answer_short,
                    confidence_score: faq.confidence_score,
                    priority: faq.priority
                })),
                faq_ids_used: faqIdsUsed,
                source: "server_ai_endpoint_with_faq"
            },
            conversation_id,
            user_email,
            user_name,
            timestamp: new Date().toISOString()
        };

        console.log("📤 Sending to N8N with FAQ context:", JSON.stringify({
            agent_type: finalAgentType,
            message_length: message.length,
            faq_count: relevantFaqs.length,
            system_type: systemTypeName,
            system_id: systemTypeId,
            category_id: categoryId,
            category_name: categoryName,
            confidence: confidence
        }, null, 2));

        // ===============================
        // CALL N8N
        // ===============================
        const n8nResponse = await fetch(
            "https://n8n.ihubtechnologies.com.au/webhook/wastevantage-chatbot",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(n8nPayload)
            }
        );

        if (!n8nResponse.ok) {
            throw new Error(`N8N responded with ${n8nResponse.status}`);
        }

        const n8nData = await n8nResponse.json();
        console.log("✅ N8N Response:", JSON.stringify(n8nData, null, 2));

        // ===============================
        // RESPONSE TIME & UPDATE FAQ USAGE
        // ===============================
        const responseTimeMs = Date.now() - startTime;

        // Update FAQ usage counts if FAQs were used
        if (faqIdsUsed.length > 0) {
            const updateUsageSql = `
                UPDATE chatbot_faq 
                SET 
                    usage_count = usage_count + 1,
                    last_used = NOW(),
                    updated_at = NOW()
                WHERE id IN (?)
            `;
            
            db.query(updateUsageSql, [faqIdsUsed], (updateErr) => {
                if (updateErr) {
                    console.error("❌ Failed to update FAQ usage:", updateErr);
                } else {
                    console.log(`✅ Updated usage for ${faqIdsUsed.length} FAQs`);
                }
            });
        }

        // ===============================
        // PERSIST TO DATABASE
        // ===============================
        const insertSql = `
            INSERT INTO chatbot_conversations
            (
                session_id,
                system_type_id,
                customer_id,
                lead_id,
                user_email,
                user_name,
                user_phone,
                user_company,
                user_ip,
                agent_type,
                category_id,
                user_message,
                ai_response,
                faq_ids_used,
                confidence,
                resolved,
                user_satisfaction,
                escalated_to_human,
                escalation_reason,
                created_ticket_id,
                created_lead_id,
                created_inquiry_id,
                created_task_id,
                response_time_ms,
                tokens_used,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        const insertValues = [
            conversation_id || `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            systemTypeId || context?.system_type_id || null,
            null, // customer_id
            null, // lead_id
            user_email || null,
            user_name,
            null, // user_phone
            null, // user_company
            req.ip || null,
            finalAgentType,
            categoryId,
            message,
            n8nData.reply || n8nData.message || "No response",
            faqIdsUsed.length > 0 ? JSON.stringify(faqIdsUsed) : null,
            confidence,
            0, // resolved
            null, // user_satisfaction
            0, // escalated_to_human
            null, // escalation_reason
            null, // created_ticket_id
            null, // created_lead_id
            null, // created_inquiry_id
            null, // created_task_id
            responseTimeMs,
            n8nData.tokens_used || null
        ];

        db.query(insertSql, insertValues, (err, result) => {
            if (err) {
                console.error("❌ Failed to save conversation:", err);
            } else {
                console.log(`✅ Conversation saved with ID: ${result.insertId}`);
            }
        });

        // ===============================
        // RETURN TO CLIENT
        // ===============================
        const clientResponse = {
            success: true,
            ...n8nData,
            agent_type: finalAgentType,
            category_id: categoryId,
            category_name: categoryName,
            system_type_id: systemTypeId,
            system_type_name: systemTypeName,
            confidence: parseFloat(confidence.toFixed(2)),
            faq_sources: relevantFaqs.length,
            faq_ids: faqIdsUsed,
            response_time_ms: responseTimeMs,
            source: "n8n_with_faq",
            timestamp: new Date().toISOString(),
            saved_to_db: true
        };

        // Add FAQ preview if available
        if (relevantFaqs.length > 0) {
            clientResponse.faq_preview = relevantFaqs.slice(0, 2).map(faq => ({
                id: faq.id,
                question: faq.question.length > 100 ? faq.question.substring(0, 100) + "..." : faq.question,
                confidence: faq.confidence_score,
                category_id: faq.category_id
            }));
        }

        return res.json(clientResponse);

    } catch (err) {
        console.error("❌ /ai/chat ERROR:", err);
        
        // Error logging
        const errorInsertSql = `
            INSERT INTO chatbot_conversations
            (session_id, agent_type, user_message, ai_response, escalated_to_human, error_message, created_at)
            VALUES (?, ?, ?, ?, 1, ?, NOW())
        `;
        
        db.query(errorInsertSql, [
            `error_${Date.now()}`,
            req.body.agent_type || "general",
            req.body.message || "",
            `Error: ${err.message}`,
            err.toString()
        ]);

        return res.status(500).json({
            success: false,
            reply: "Our AI service is temporarily unavailable. Please try again.",
            agent_type: req.body.agent_type || "general",
            source: "error_fallback",
            timestamp: new Date().toISOString(),
            error: err.message
        });
    }
});


// Helper: Build enhanced prompt
function buildEnhancedPrompt(promptData, similarConversations, context) {
    // Ambil agent_type dari promptData atau default ke "general"
    const agentType = promptData.agent_type || "general";
    
    let prompt = `
IDENTITY: ${promptData.identity || 'AI Assistant'}
ROLE: ${promptData.role_description || ''}
KNOWLEDGE BASE: ${promptData.context_knowledge || ''}
LANGUAGE: ${promptData.language || 'australian_english'}
TONE: ${promptData.tone || 'professional'}

PRIMARY GOALS:
${promptData.primary_goals || ''}

DO GUIDELINES:
${promptData.do_guidelines || ''}

DON'T GUIDELINES:
${promptData.dont_guidelines || ''}

RESPONSE FORMAT: ${promptData.response_format || 'clear and concise'}

CURRENT CONTEXT:
${JSON.stringify(context, null, 2)}
`;
    
    // Tambahkan learning dari similar conversations
    if (similarConversations.length > 0) {
        prompt += "\n\nLEARNED FROM PAST SIMILAR CONVERSATIONS:\n";
        similarConversations.forEach((conv, index) => {
            prompt += `
[Example ${index + 1}]:
User: ${conv.user_message}
Assistant: ${conv.ai_response}
Outcome: ${conv.resolved ? 'Resolved' : 'Not resolved'} (Confidence: ${conv.confidence})
${conv.user_satisfaction ? `User Feedback: ${conv.user_satisfaction}` : ''}
---`;
        });
        
        prompt += "\n\nUse insights from these past conversations to inform your response.";
    }
    
    // Tambahkan routing rules jika ada
    if (promptData.routing_rules) {
        prompt += `\n\nROUTING RULES:\n${promptData.routing_rules}`;
    }
    
    // Tambahkan escalation triggers jika ada
    if (promptData.escalation_triggers) {
        prompt += `\n\nESCALATION TRIGGERS:\n${promptData.escalation_triggers}`;
    }
    
    // KOREKSI: Tambahkan parameter agentType (ke-3)
    return buildSystemPromptForN8N(promptData, context, agentType);
}

// Helper: Build OpenAI messages
function buildOpenAIMessages(systemPrompt, userMessage, history, context) {
    const messages = [
        { role: "system", content: systemPrompt }
    ];

    // Add context as user message
    if (Object.keys(context).length > 0) {
        messages.push({
            role: "user",
            content: `Additional context: ${JSON.stringify(context, null, 2)}`
        });
    }

    // Add history
    history.forEach(msg => {
        messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
        });
    });

    // Add current message
    messages.push({ role: "user", content: userMessage });

    return messages;
}

app.get("/n8n/test", (req, res) => {
    res.json({
        status: "online",
        message: "Server is running on port 3000",
        timestamp: new Date().toISOString(),
        endpoints: {
            getPrompt: "POST /n8n/get-prompt",
            aiChat: "POST /ai/chat",
            liveChat: "Various endpoints"
        }
    });
});

// Test endpoint untuk prompt database
app.get("/n8n/test-prompt/:agent_type", async (req, res) => {
    const agent_type = req.params.agent_type;
    
    try {
        const promptData = await getAgentPrompt(agent_type);
        
        if (!promptData) {
            return res.json({
                exists: false,
                message: `No prompt found for ${agent_type}`,
                suggestion: "Check chatbot_prompts table"
            });
        }
        
        const testPrompt = buildSystemPromptForN8N(promptData, {
            product: "test",
            user_name: "Test User"
        });
        
        res.json({
            exists: true,
            agent_type: agent_type,
            prompt_data: {
                identity: promptData.identity,
                version: promptData.version,
                status: promptData.status,
                is_active: promptData.is_active
            },
            system_prompt_preview: testPrompt.substring(0, 500) + "...",
            total_length: testPrompt.length
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// Endpoint untuk melihat semua prompts aktif
app.get("/test/all-prompts", async (req, res) => {
    try {
        const query = `
            SELECT agent_type, version, identity, status, is_active
            FROM chatbot_prompts 
            WHERE is_active = 1
            ORDER BY agent_type, version DESC
        `;
        
        db.query(query, (error, results) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }
            
            const grouped = results.reduce((acc, prompt) => {
                if (!acc[prompt.agent_type]) {
                    acc[prompt.agent_type] = [];
                }
                acc[prompt.agent_type].push(prompt);
                return acc;
            }, {});
            
            res.json({
                success: true,
                prompts: grouped,
                count: results.length
            });
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/ai/test-prompt/:agent_type", (req, res) => {
    const agent_type = req.params.agent_type;
    
    getAgentPrompt(agent_type).then(promptData => {
        if (promptData) {
            res.json({
                success: true,
                agent_type: agent_type,
                prompt: {
                    identity: promptData.identity,
                    version: promptData.version,
                    role: promptData.role_description.substring(0, 100) + '...'
                },
                status: 'active'
            });
        } else {
            res.json({
                success: false,
                error: `No active prompt found for ${agent_type}`,
                suggestion: 'Check chatbot_prompts table'
            });
        }
    });
});

// Endpoint untuk analytics
app.get("/ai/analytics/:agent_type", (req, res) => {
    const agent_type = req.params.agent_type;
    
    let query = `
        SELECT 
            agent_type,
            COUNT(*) as total_conversations,
            AVG(confidence) as avg_confidence,
            SUM(resolved) as resolved_count,
            AVG(response_time_ms) as avg_response_time,
            SUM(tokens_used) as total_tokens,
            SUM(escalated_to_human) as escalated_count,
            DATE(created_at) as date
        FROM chatbot_conversations
    `;
    
    const params = [];
    
    if (agent_type) {
        query += ` WHERE agent_type = ?`;
        params.push(agent_type);
    }
    
    query += ` GROUP BY DATE(created_at), agent_type ORDER BY date DESC LIMIT 30`;
    
    db.query(query, params, (error, results) => {
        if (error) {
            console.error("Analytics query error:", error);
            return res.status(500).json({ error: "Database error" });
        }
        
        // Calculate additional metrics
        const metrics = {
            by_agent: {},
            overall: {
                total_conversations: 0,
                avg_confidence: 0,
                resolution_rate: 0,
                escalation_rate: 0
            }
        };
        
        results.forEach(row => {
            if (!metrics.by_agent[row.agent_type]) {
                metrics.by_agent[row.agent_type] = [];
            }
            metrics.by_agent[row.agent_type].push(row);
            
            // Aggregate overall
            metrics.overall.total_conversations += row.total_conversations;
            metrics.overall.avg_confidence += row.avg_confidence * row.total_conversations;
        });
        
        if (metrics.overall.total_conversations > 0) {
            metrics.overall.avg_confidence /= metrics.overall.total_conversations;
            
            // Calculate rates
            const resolved = results.reduce((sum, row) => sum + (row.resolved_count || 0), 0);
            const escalated = results.reduce((sum, row) => sum + (row.escalated_count || 0), 0);
            
            metrics.overall.resolution_rate = (resolved / metrics.overall.total_conversations) * 100;
            metrics.overall.escalation_rate = (escalated / metrics.overall.total_conversations) * 100;
        }
        
        res.json({
            success: true,
            analytics: metrics,
            time_range: 'last_30_days',
            timestamp: new Date().toISOString()
        });
    });
});

app.post("/n8n/get-prompt", async (req, res) => {
  console.log("🔧 N8N Request: Get prompt");
  
  let rawBody = '';
  req.on('data', chunk => {
    rawBody += chunk.toString();
  });
  
  req.on('end', async () => {
    console.log("📦 Raw request body length:", rawBody.length);
    
    try {
      let body = {};
      
      if (rawBody.trim()) {
        try {
          body = JSON.parse(rawBody);
          console.log("✅ Successfully parsed JSON body");
        } catch (parseError) {
          console.log("⚠️ Could not parse as JSON");
        }
      }
      
      const rawAgentType = body.agent_type;
      const context = body.context || {};
      
      console.log("🔍 Raw agent_type from request:", rawAgentType);
      
      // Determine agent_type
      let agentTypeForQuery = "general";
      
      if (rawAgentType && typeof rawAgentType === "string") {
        const cleanAgentType = rawAgentType.toLowerCase().trim();
        const allowedTypes = ["sales", "support", "automation", "general"];
        
        if (allowedTypes.includes(cleanAgentType)) {
          agentTypeForQuery = cleanAgentType;
          console.log("✅ Using valid agent_type:", agentTypeForQuery);
        }
      }
      
      console.log("🔍 Final agent_type for query:", agentTypeForQuery);

      // ⚠️ PERBAIKAN PENTING: Query yang benar berdasarkan data database
      const query = `
        SELECT * FROM chatbot_prompts
        WHERE agent_type = ?
        AND is_active = 1
        ORDER BY 
          CASE 
            WHEN status = 'active' THEN 1
            WHEN status = 'testing' THEN 2
            WHEN status = 'draft' THEN 3
            ELSE 4
          END,
          version DESC
        LIMIT 1
      `;

      console.log(`📡 Query Database: "${agentTypeForQuery}"`);
      
      db.query(query, [agentTypeForQuery], (error, results) => {
        if (error) {
          console.error("❌ Database error:", error);
          return createDefaultPrompt(agentTypeForQuery, context, res, "database_error");
        }

        console.log(`🔍 Database results: ${results.length} rows`);
        
        if (results.length > 0) {
          const prompt = results[0];
          console.log(`✅ Found prompt for "${agentTypeForQuery}": ${prompt.identity}`);
          console.log(`📊 Prompt status: ${prompt.status}, is_active: ${prompt.is_active}`);
          
          const systemPrompt = buildSystemPromptForN8N(prompt, context, agentTypeForQuery);
          
          return res.json({
            success: true,
            prompt: {
              system_prompt: systemPrompt,
              identity: prompt.identity,
              agent_type: agentTypeForQuery,
              language: prompt.language || "australian_english",
              tone: prompt.tone || "professional",
              version: prompt.version || "v1.0",
              context_knowledge: prompt.context_knowledge || "",
              role_description: prompt.role_description || "",
              status: prompt.status || "draft"
            },
            is_fallback: false,
            timestamp: new Date().toISOString(),
            debug: {
              requested_agent_type: rawAgentType,
              response_agent_type: agentTypeForQuery,
              db_status: prompt.status,
              db_is_active: prompt.is_active,
              note: "Using prompt from database"
            }
          });
        }
        
        // Jika tidak ditemukan, buat default
        console.log(`⚠️ No prompt found for "${agentTypeForQuery}" in database`);
        return createDefaultPrompt(agentTypeForQuery, context, res, "no_prompt_in_db");
      });

    } catch (error) {
      console.error("❌ N8N get-prompt error:", error);
      const agentType = body.agent_type || "general";
      createDefaultPrompt(agentType, body.context || {}, res, "catch_error");
    }
  });
});

// 🔧 Helper function untuk hardcoded fallback response
function sendHardcodedFallbackResponse(requestedAgentType, context, res, reason) {
  console.log(`🔄 Sending hardcoded fallback response due to: ${reason}`);
  
  // SELALU gunakan "general" untuk fallback hardcoded
  const fallbackAgentType = "general";
  
  const fallbackPrompt = {
    identity: `${fallbackAgentType.charAt(0).toUpperCase() + fallbackAgentType.slice(1)} Assistant`,
    context_knowledge: "General information about iHub products and services.",
    role_description: `Assist with ${fallbackAgentType} related inquiries.`,
    language: "australian_english",
    tone: "professional"
  };
  
  const systemPrompt = buildSystemPromptForN8N(fallbackPrompt, context, fallbackAgentType);

  res.json({
    success: true,
    prompt: {
      system_prompt: systemPrompt,
      identity: fallbackPrompt.identity,
      agent_type: fallbackAgentType, // ⚠️ GUNAKAN "general"
      language: fallbackPrompt.language,
      tone: fallbackPrompt.tone,
      version: "hardcoded_fallback",
      context_knowledge: fallbackPrompt.context_knowledge,
      role_description: fallbackPrompt.role_description
    },
    is_fallback: true,
    timestamp: new Date().toISOString(),
    debug: {
      requested_agent_type: requestedAgentType,
      response_agent_type: fallbackAgentType,
      fallback_reason: reason
    }
  });
}

function sendHardcodedFallbackResponse(requestedAgentType, context, res) {
  console.log(`🔄 Sending hardcoded fallback response`);
  
  // SELALU gunakan "general" untuk fallback hardcoded
  const fallbackAgentType = "general";
  
  const fallbackPrompt = {
    identity: `${fallbackAgentType.charAt(0).toUpperCase() + fallbackAgentType.slice(1)} Assistant`,
    context_knowledge: "General information about iHub products and services.",
    role_description: `Assist with ${fallbackAgentType} related inquiries.`,
    language: "australian_english",
    tone: "professional"
  };
  
  const systemPrompt = buildSystemPromptForN8N(fallbackPrompt, context, fallbackAgentType);

  res.json({
    success: true,
    prompt: {
      system_prompt: systemPrompt,
      identity: fallbackPrompt.identity,
      agent_type: fallbackAgentType, // ⚠️ GUNAKAN "general"
      language: fallbackPrompt.language,
      tone: fallbackPrompt.tone,
      version: "hardcoded_fallback",
      context_knowledge: fallbackPrompt.context_knowledge,
      role_description: fallbackPrompt.role_description
    },
    is_fallback: true,
    timestamp: new Date().toISOString(),
    debug: {
      requested_agent_type: requestedAgentType,
      response_agent_type: fallbackAgentType,
      fallback_reason: "no_prompts_in_database"
    }
  });
}

// 🔧 Helper function to handle query results
function handleQueryResults(error, results, rawAgentType, queryAgentType, context, res) {
  if (error) {
    console.error("❌ Query error:", error);
    return sendFallbackResponse(rawAgentType, context, res, "query_error");
  }

  if (results.length === 0) {
    console.log(`❌ No prompt found for "${queryAgentType}", using fallback`);
    return sendFallbackResponse(rawAgentType, context, res, "no_results");
  }

  const prompt = results[0];
  console.log(`✅ Found prompt for "${queryAgentType}": ${prompt.identity}`);
  
  // 🔒 CRITICAL: Use REQUESTED agent_type, not database agent_type
  const responseAgentType = rawAgentType || queryAgentType || "general";
  console.log(`🔍 Response agent_type: "${responseAgentType}"`);
  
  // Build system prompt - FORCE correct agent_type
  const systemPrompt = buildSystemPromptForN8N(prompt, context, responseAgentType);

  res.json({
    success: true,
    prompt: {
      system_prompt: systemPrompt,
      identity: prompt.identity,
      agent_type: responseAgentType, // 🔥 USE REQUESTED TYPE
      language: prompt.language || "australian_english",
      tone: prompt.tone || "professional",
      version: prompt.version || "v1.0",
      context_knowledge: prompt.context_knowledge || "",
      role_description: prompt.role_description || "",
      status: prompt.status || "active"
    },
    is_fallback: false,
    timestamp: new Date().toISOString(),
    debug: {
      requested_agent_type: rawAgentType,
      query_agent_type: queryAgentType,
      db_agent_type: prompt.agent_type,
      response_agent_type: responseAgentType,
      note: "Using requested agent_type for response"
    }
  });
}

// 🔧 Helper function for fallback queries
function handleFallbackQuery(error, results, rawAgentType, originalQueryAgentType, context, res) {
  if (error) {
    console.error("❌ Fallback query error:", error);
    return sendFallbackResponse(rawAgentType, context, res, "fallback_error");
  }

  if (results.length === 0) {
    console.log("❌ No general prompt found either, using basic fallback");
    return sendFallbackResponse(rawAgentType, context, res, "no_general_fallback");
  }

  const prompt = results[0];
  console.log(`🔄 Using general fallback prompt`);
  
  // Still use requested agent_type even with fallback prompt
  const responseAgentType = rawAgentType || "general";
  const systemPrompt = buildSystemPromptForN8N(prompt, context, responseAgentType);

  res.json({
    success: true,
    prompt: {
      system_prompt: systemPrompt,
      identity: prompt.identity,
      agent_type: responseAgentType, // 🔥 STILL USE REQUESTED TYPE
      language: prompt.language || "australian_english",
      tone: prompt.tone || "professional",
      version: prompt.version || "v1.0",
      context_knowledge: prompt.context_knowledge || "",
      role_description: prompt.role_description || ""
    },
    is_fallback: true,
    timestamp: new Date().toISOString(),
    debug: {
      requested_agent_type: rawAgentType,
      original_query_agent_type: originalQueryAgentType,
      fallback_agent_type: "general",
      response_agent_type: responseAgentType,
      note: "Used general prompt as fallback"
    }
  });
}

// 🔧 Helper function for fallback responses
function sendFallbackResponse(requestedAgentType, context, res, reason) {
  console.log(`🔄 Sending fallback response due to: ${reason}`);
  
  const responseAgentType = requestedAgentType || "general";
  const fallbackPrompt = {
    identity: `${responseAgentType.charAt(0).toUpperCase() + responseAgentType.slice(1)} Assistant`,
    context_knowledge: "General information about iHub products and services.",
    role_description: `Assist with ${responseAgentType} related inquiries.`,
    language: "australian_english",
    tone: "professional"
  };
  
  const systemPrompt = buildSystemPromptForN8N(fallbackPrompt, context, responseAgentType);

  res.json({
    success: true,
    prompt: {
      system_prompt: systemPrompt,
      identity: fallbackPrompt.identity,
      agent_type: responseAgentType, // 🔥 USE REQUESTED TYPE
      language: fallbackPrompt.language,
      tone: fallbackPrompt.tone,
      version: "fallback_1.0",
      context_knowledge: fallbackPrompt.context_knowledge,
      role_description: fallbackPrompt.role_description
    },
    is_fallback: true,
    timestamp: new Date().toISOString(),
    debug: {
      requested_agent_type: requestedAgentType,
      response_agent_type: responseAgentType,
      fallback_reason: reason
    }
  });
}

app.get("/ai/prompts", (req, res) => {
    const query = `
        SELECT id, agent_type, version, identity, status, is_active
        FROM chatbot_prompts 
        WHERE is_active = 1 
        ORDER BY agent_type, version DESC
    `;

    db.query(query, (error, results) => {
        if (error) {
            console.error("Prompts query error:", error);
            return res.status(500).json({ error: "Database error" });
        }

        // Group by agent_type
        const grouped = results.reduce((acc, prompt) => {
            if (!acc[prompt.agent_type]) {
                acc[prompt.agent_type] = [];
            }
            acc[prompt.agent_type].push(prompt);
            return acc;
        }, {});

        res.json({
            success: true,
            prompts: grouped,
            count: results.length,
            agent_types: Object.keys(grouped)
        });
    });
});

// -----------------------------------------------------
// AI DASHBOARD ENDPOINTS
// -----------------------------------------------------

// Real-time dashboard data
app.get("/ai/dashboard", (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    
    const queries = {
        today_stats: `
            SELECT 
                agent_type,
                COUNT(*) as conversations,
                AVG(confidence) as avg_confidence,
                SUM(resolved) as resolved,
                AVG(response_time_ms) as avg_response_time
            FROM chatbot_conversations
            WHERE DATE(created_at) = ?
            GROUP BY agent_type
        `,
        
        top_conversations: `
            SELECT 
                session_id,
                user_message,
                ai_response,
                confidence,
                resolved,
                agent_type,
                TIMESTAMPDIFF(MINUTE, created_at, NOW()) as minutes_ago
            FROM chatbot_conversations
            WHERE DATE(created_at) = ?
            ORDER BY confidence DESC
            LIMIT 10
        `,
        
        escalation_stats: `
            SELECT 
                agent_type,
                COUNT(*) as total,
                SUM(escalated_to_human) as escalated,
                GROUP_CONCAT(DISTINCT escalation_reason) as reasons
            FROM chatbot_conversations
            WHERE DATE(created_at) = ?
            GROUP BY agent_type
        `
    };
    
    // Execute all queries
    Promise.all([
        dbQuery(queries.today_stats, [today]),
        dbQuery(queries.top_conversations, [today]),
        dbQuery(queries.escalation_stats, [today])
    ]).then(([todayStats, topConvs, escalationStats]) => {
        
        // Calculate insights
        const insights = [];
        
        // Low confidence alert
        todayStats.forEach(stat => {
            if (stat.avg_confidence < 0.6) {
                insights.push({
                    type: 'warning',
                    message: `Low confidence (${Math.round(stat.avg_confidence * 100)}%) for ${stat.agent_type} agent`,
                    suggestion: 'Consider updating prompts or adding training data'
                });
            }
        });
        
        // High escalation alert
        escalationStats.forEach(stat => {
            const escalationRate = (stat.escalated / stat.total) * 100;
            if (escalationRate > 20) {
                insights.push({
                    type: 'alert',
                    message: `High escalation rate (${Math.round(escalationRate)}%) for ${stat.agent_type}`,
                    suggestion: 'Review escalation triggers or improve AI responses'
                });
            }
        });
        
        res.json({
            success: true,
            dashboard: {
                today: today,
                stats: {
                    by_agent: todayStats,
                    total_conversations: todayStats.reduce((sum, s) => sum + s.conversations, 0),
                    avg_response_time: todayStats.reduce((sum, s) => sum + s.avg_response_time, 0) / todayStats.length
                },
                top_conversations: topConvs,
                escalation_analysis: escalationStats,
                insights: insights,
                last_updated: new Date().toISOString()
            }
        });
        
    }).catch(error => {
        console.error("Dashboard query error:", error);
        res.status(500).json({ error: "Dashboard data error" });
    });
});

// FUNGSI YANG BENAR (tunggal):
function buildSystemPromptForN8N(promptData, context, agentType) {
  // Ensure agentType is always set
  const finalAgentType = agentType;
  
  console.log(`🔍 Building prompt for agent_type: "${finalAgentType}"`);
  console.log(`🔍 promptData.agent_type: "${promptData.agent_type}"`);
  console.log(`🔍 parameter agentType: "${agentType}"`);

  const roleRules = {
    sales: `
- You MAY discuss pricing, plans, and subscriptions
- You MAY guide users toward purchase decisions
- Focus on product features and benefits
- Provide clear pricing information when asked`,
    
    support: `
- Focus on troubleshooting and issue resolution
- DO NOT discuss pricing or sales topics
- Provide technical assistance and solutions
- Escalate billing issues to sales team`,
    
    automation: `
- Explain workflows, integrations, and automations
- Focus on technical implementation steps
- DO NOT discuss pricing or sales topics
- Provide guidance on setup and configuration`,
    
    general: `
- Provide high-level product information
- DO NOT discuss pricing or technical details
- Route specific inquiries to appropriate teams
- Maintain general assistance role`
  };

  const userInfo = context.user_name ? `User: ${context.user_name}` : "";
  const productInfo = context.product ? `Product: ${context.product}` : "";
  
  const prompt = `
# IDENTITY
${promptData.identity || `You are a ${finalAgentType} AI assistant for iHub products.`}

# RESPONSIBILITIES
${promptData.role_description || `Assist users with ${finalAgentType} related inquiries.`}

# KNOWLEDGE BASE
${promptData.context_knowledge || "General information about iHub products and services."}

# CONTEXT
${userInfo}
${productInfo}
${context.chat_history_length ? `Chat History Length: ${context.chat_history_length}` : ""}

# ROLE-SPECIFIC RULES
${roleRules[finalAgentType] || roleRules.general}

# COMMUNICATION STYLE
Language: ${promptData.language || "australian_english"}
Tone: ${promptData.tone || "professional"}

# HARD CONSTRAINTS
1. You MUST act strictly as a ${finalAgentType} agent
2. You are NOT allowed to switch roles
3. If a request is outside your role, politely redirect
4. Always maintain professional and helpful tone

# FINAL INSTRUCTION
Answer the user's question clearly, accurately, and according to your role constraints.
`.trim();

  console.log(`🔍 Built prompt length: ${prompt.length} chars`);
  console.log(`🔍 Prompt starts with: ${prompt.substring(0, 100)}...`);
  
  return prompt;
}

// Endpoint untuk N8N mengirim chat dengan database prompt
app.post("/n8n/chat-with-prompt", async (req, res) => {
    try {
        const { 
            agent_type, 
            message, 
            conversation_id,
            user_name,
            context = {}
        } = req.body;
        
        console.log(`💬 N8N Chat: ${agent_type} - "${message.substring(0, 50)}..."`);
        
        // 1. Ambil prompt dari database
        const promptData = await getAgentPrompt(agent_type);
        
        if (!promptData) {
            return res.json({
                success: true,
                reply: `I'm here to help with ${agent_type} inquiries. How can I assist you?`,
                source: 'fallback_no_prompt',
                agent_type: agent_type
            });
        }
        
        // 2. Simpan conversation untuk learning
        const conversationData = {
            session_id: conversation_id || `n8n_${Date.now()}`,
            agent_type: agent_type,
            user_message: message,
            context: context,
            prompt_id: promptData.id,
            created_at: new Date().toISOString()
        };
        
        saveConversationToDatabase(conversationData);
        
        // 3. Return structured data untuk N8N
        res.json({
            success: true,
            n8n_ready: true,
            agent_type: agent_type,
            prompt_info: {
                identity: promptData.identity,
                version: promptData.version,
                tone: promptData.tone,
                language: promptData.language
            },
            context: context,
            user_message: message,
            conversation_id: conversation_id,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error("❌ N8N chat error:", error);
        res.json({
            success: true,
            reply: `I received your message. As the ${req.body.agent_type} assistant, I'll help you with that.`,
            agent_type: req.body.agent_type,
            source: 'error_fallback'
        });
    }
});    


// Helper: Generate response dari prompt template
function generateResponseFromPrompt(promptData, userMessage, context) {
    const productName = context.product === 'wastevantage' ? 'WasteVantage' : 
                       context.product === 'hithatereai' ? 'HiThereAI' : 'our product';
    
    // Base template berdasarkan agent_type
    const templates = {
        'sales': `Regarding your inquiry about "${userMessage}", as a ${promptData.identity}, I recommend discussing this with our sales team for accurate pricing and personalized solutions for ${productName}. Would you like me to connect you?`,
        'support': `For ${productName} support regarding "${userMessage}", please provide more details or contact our support team at support@ihub.com.`,
        'automation': `For HiThereAI automation solutions about "${userMessage}", we specialize in workflow automation. What specific process would you like to automate?`,
        'general': `Regarding "${userMessage}", I can help you with iHub products. What specific information do you need?`
    };
    
    return templates[promptData.agent_type] || templates.general;
}

// Cari conversations yang similar untuk learning
async function findSimilarConversations(currentMessage, agent_type, limit = 5) {
    return new Promise((resolve, reject) => {
        // Use better search - look for keywords in the message
        const keywords = currentMessage.toLowerCase().split(' ').filter(word => word.length > 3);
        let searchCondition = '';
        let params = [agent_type];
        
        if (keywords.length > 0) {
            // Build OR conditions for each keyword
            const keywordConditions = keywords.map(keyword => `user_message LIKE ?`).join(' OR ');
            searchCondition = `AND (${keywordConditions})`;
            params = params.concat(keywords.map(keyword => `%${keyword}%`));
        }
        
        const query = `
            SELECT 
                id,
                user_message,
                ai_response,
                confidence,
                resolved,
                user_satisfaction,
                TIMESTAMPDIFF(HOUR, created_at, NOW()) as hours_ago
            FROM chatbot_conversations 
            WHERE agent_type = ?
            ${searchCondition}
            AND confidence > 0.6
            ORDER BY 
                CASE 
                    WHEN resolved = 1 AND user_satisfaction = 'helpful' THEN 1
                    WHEN resolved = 1 THEN 2
                    ELSE 3
                END,
                confidence DESC,
                hours_ago ASC
            LIMIT ?
        `;
        
        params.push(limit);
        
        db.query(query, params, (error, results) => {
            if (error) {
                console.error("Similar conversations query error:", error);
                resolve([]);
            } else {
                console.log(`🔍 Found ${results.length} similar conversations for "${currentMessage}"`);
                results.forEach((r, i) => {
                    console.log(`   ${i+1}. "${r.user_message.substring(0, 50)}..." (conf: ${r.confidence})`);
                });
                resolve(results);
            }
        });
    });
}

    // Ambil prompt dengan version terbaru
async function getAgentPrompt(agent_type, forceGeneralFallback = false) {
    return new Promise((resolve, reject) => {
        console.log(`🔍 getAgentPrompt called for: "${agent_type}"`);
        
        // Cari spesifik dulu
        const query = `
            SELECT * FROM chatbot_prompts 
            WHERE agent_type = ? 
            AND is_active = 1 
            AND status = 'active'
            ORDER BY version DESC 
            LIMIT 1
        `;
        
        db.query(query, [agent_type], (error, results) => {
            if (error) {
                console.error("❌ Get prompt error:", error);
                resolve(null);
            } else if (results.length === 0) {
                console.log(`⚠️ No active prompt found for "${agent_type}"`);
                
                // Fallback ke general JIKA DIIZINKAN
                if (forceGeneralFallback) {
                    console.log(`🔄 Trying fallback to general...`);
                    // Rekursi dengan parameter general
                    getAgentPrompt("general", false).then(generalPrompt => {
                        resolve(generalPrompt);
                    });
                } else {
                    resolve(null);
                }
            } else {
                const prompt = results[0];
                console.log(`✅ Prompt found for ${agent_type}: ${prompt.identity}`);
                resolve(prompt);
            }
        });
    });
}

// Bangun enhanced prompt dengan learning

async function callN8NWebhook(data, endpoint = "wastevantage-chatbot") {
    const n8nUrl = `https://n8n.ihubtechnologies.com.au/webhook/${endpoint}`;
    
    console.log(`🔗 Calling N8N: ${n8nUrl}`);
    console.log(`   Request data:`, JSON.stringify(data, null, 2));
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetch(n8nUrl, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "X-Source": "ihub-server"
            },
            body: JSON.stringify(data),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        console.log(`   Response Status: ${response.status} ${response.statusText}`);
        
        const responseText = await response.text();
        console.log(`   Response Body (first 500 chars): ${responseText.substring(0, 500)}`);
        
        // Try to parse as JSON
        try {
            const jsonResponse = JSON.parse(responseText);
            console.log(`   ✅ JSON parsed successfully`);
            return { success: true, status: response.status, data: jsonResponse };
        } catch (parseError) {
            console.log(`   ⚠️ Response is not JSON: ${parseError.message}`);
            return { 
                success: false, 
                status: response.status, 
                error: "Response not JSON", 
                raw: responseText 
            };
        }
        
    } catch (error) {
        console.log(`   ❌ Fetch error: ${error.message}`);
        return { success: false, error: error.message };
    }
}


// Analisa response untuk business logic
function analyzeResponse(aiResponse, userMessage, agent_type) {
    const analysis = {
        confidence: 0.8, // Default
        resolved: false,
        escalation_needed: false,
        escalation_reason: null,
        category_id: null,
        faq_ids: [],
        create_ticket: false,
        create_lead: false,
        ticket_id: null,
        lead_id: null,
        suggested_actions: []
    };
    
    // Deteksi berdasarkan keyword
    const lowerMessage = userMessage.toLowerCase();
    const lowerResponse = aiResponse.toLowerCase();
    
    // Support issues
    if (agent_type === 'support') {
        if (lowerMessage.includes('error') || lowerMessage.includes('not working') || 
            lowerMessage.includes('problem') || lowerMessage.includes('issue')) {
            analysis.category_id = 15; // Support category
            analysis.create_ticket = !lowerResponse.includes('resolved') && 
                                    !lowerResponse.includes('fixed') &&
                                    !lowerResponse.includes('solved');
        }
    }
    
    // Sales inquiries
    if (agent_type === 'sales') {
        if (lowerMessage.includes('price') || lowerMessage.includes('cost') ||
            lowerMessage.includes('buy') || lowerMessage.includes('purchase') ||
            lowerMessage.includes('demo')) {
            analysis.category_id = 22; // Sales category
            analysis.create_lead = lowerMessage.includes('demo') || 
                                  lowerMessage.includes('contact me') ||
                                  lowerResponse.includes('sales team');
        }
    }
    
    // Escalation detection
    const escalationKeywords = ['talk to human', 'speak to person', 'real person', 
                               'live agent', 'customer service', 'manager'];
    if (escalationKeywords.some(keyword => lowerMessage.includes(keyword))) {
        analysis.escalation_needed = true;
        analysis.escalation_reason = 'User requested human assistance';
    }
    
    // Confidence calculation (sederhana)
    if (lowerResponse.includes('i don\'t know') || lowerResponse.includes('i\'m not sure')) {
        analysis.confidence = 0.3;
        analysis.resolved = false;
    } else if (lowerResponse.length > 100 && !lowerResponse.includes('?')) {
        analysis.confidence = 0.9;
        analysis.resolved = true;
    }
    
    return analysis;
}

// Simpan ke conversations dengan enhanced data
async function saveEnhancedConversation(data) {
    const query = `
        INSERT INTO chatbot_conversations (
            session_id, system_type_id, customer_id, lead_id, 
            user_email, user_name, user_phone, user_company, user_ip,
            agent_type, category_id, user_message, ai_response,
            faq_ids_used, confidence, resolved, user_satisfaction,
            escalated_to_human, escalation_reason, created_ticket_id,
            created_lead_id, response_time_ms, tokens_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const values = [
        data.session_id,
        data.system_type_id,
        data.customer_id,
        data.lead_id,
        data.user_email,
        data.user_name,
        data.user_phone,
        data.user_company,
        data.user_ip,
        data.agent_type,
        data.category_id,
        data.user_message,
        data.ai_response,
        JSON.stringify(data.faq_ids_used),
        data.confidence,
        data.resolved ? 1 : 0,
        data.user_satisfaction,
        data.escalated_to_human ? 1 : 0,
        data.escalation_reason,
        data.created_ticket_id,
        data.created_lead_id,
        data.response_time_ms,
        data.tokens_used
    ];
    
    db.query(query, values, (error, result) => {
        if (error) {
            console.error("Save conversation error:", error);
        } else {
            console.log(`💾 Saved conversation #${result.insertId} for ${data.agent_type}`);
        }
    });
}

// Endpoint untuk feedback dari user
app.post("/ai/feedback", (req, res) => {
    const { conversation_id, satisfaction, feedback_text } = req.body;
    
    const query = `
        UPDATE chatbot_conversations 
        SET user_satisfaction = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? 
        ORDER BY created_at DESC 
        LIMIT 1
    `;
    
    db.query(query, [satisfaction, conversation_id], (error, result) => {
        if (error) {
            console.error("Feedback update error:", error);
            return res.status(500).json({ error: "Failed to save feedback" });
        }
        
        // Juga update confidence berdasarkan feedback
        if (satisfaction === 'helpful') {
            // Increase confidence for similar future responses
            updateConfidenceScore(conversation_id, 'increase');
        } else if (satisfaction === 'not_helpful') {
            updateConfidenceScore(conversation_id, 'decrease');
        }
        
        res.json({
            success: true,
            message: "Thank you for your feedback!",
            affected_rows: result.affectedRows
        });
    });
});

// Update confidence score untuk learning
function updateConfidenceScore(conversation_id, direction) {
    const query = `
        UPDATE chatbot_conversations 
        SET confidence = confidence ${direction === 'increase' ? '+' : '-'} 0.1
        WHERE session_id = ? 
        AND confidence IS NOT NULL
    `;
    
    db.query(query, [conversation_id], (error) => {
        if (error) {
            console.error("Update confidence error:", error);
        }
    });
}



// Test endpoint untuk verifikasi prompt database


// Fallback ke N8N
async function handleWithN8N(req, res) {
    try {
        const n8nResponse = await fetch("https://n8n.ihubtechnologies.com.au/webhook/wastevantage-chatbot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body)
        });

        if (!n8nResponse.ok) throw new Error("N8N fallback failed");
        
        const data = await n8nResponse.json();
        
        res.json({
            success: true,
            reply: data.reply,
            agent_type: req.body.agent_type,
            source: 'n8n_fallback'
        });
    } catch (n8nError) {
        res.status(500).json({
            success: false,
            error: "Both AI and N8N failed",
            fallback_message: "I apologize, but I'm having trouble processing your request. Please try again or contact support directly."
        });
    }
}

// Ambil history percakapan
async function getConversationHistory(conversation_id) {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT role, content, timestamp 
            FROM conversation_logs 
            WHERE conversation_id = ? 
            ORDER BY timestamp ASC 
            LIMIT 10
        `;
        
        db.query(query, [conversation_id], (error, results) => {
            if (error) {
                console.error("History query error:", error);
                resolve([]);
            } else {
                resolve(results);
            }
        });
    });
}

// Simpan percakapan
async function saveConversation(conversation_id, role, content) {
    const query = `
        INSERT INTO conversation_logs (conversation_id, role, content) 
        VALUES (?, ?, ?)
    `;
    
    db.query(query, [conversation_id, role, content]);
}

// Endpoint untuk mengambil semua prompt aktif


// Helper function untuk query
function dbQuery(sql, params) {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (error, results) => {
            if (error) {
                reject(error);
            } else {
                resolve(results);
            }
        });
    });
}

// -----------------------------------------------------
// CHAT GREETING API (From Database) - UPDATED VERSION
// -----------------------------------------------------
app.get("/api/chat/greeting", (req, res) => {
    console.log("🔍 /api/chat/greeting endpoint called");

    // Query yang sesuai dengan struktur database Anda
    const query = `
        SELECT message_text 
        FROM chatbot_welcome_messages 
        WHERE is_active = 1 
        ORDER BY id DESC 
        LIMIT 1
    `;

    console.log("📊 Executing query:", query);

    db.query(query, (error, results) => {
        if (error) {
            console.error("❌ Database error in /api/chat/greeting:", error);
            
            // Return fallback dengan format yang benar
            return res.json({
                success: true,
                fallback: true,
                data: {
                    message: "👋 Welcome to iHub! How can I assist you today? Please select an option:\n\n" +
                            "1️⃣ General Questions\n" +
                            "2️⃣ WasteVantage Sales\n" + 
                            "3️⃣ Automation Sales\n" +
                            "4️⃣ Ihub Product Support"
                }
            });
        }

        console.log("📋 Query results:", results);

        if (results.length === 0) {
            console.log("ℹ️ No active greeting found in database");
            return res.json({
                success: true,
                data: {
                    message: "👋 Welcome to iHub! How can I assist you today? Please select an option:\n\n" +
                            "1️⃣ General Questions\n" +
                            "2️⃣ WasteVantage Sales\n" + 
                            "3️⃣ Automation Sales\n" +
                            "4️⃣ Ihub Product Support"
                }
            });
        }

        const text = results[0].message_text;
        
        console.log("✅ Greeting fetched from database:", text.substring(0, 100) + "...");

        return res.json({
            success: true,
            data: {
                message: text
            }
        });
    });
});

function getDefaultGreeting() {
    return {
        message: "👋 Cannot connect to database. Using default greeting..."
    };
}

async function safeQuery(
  sql,
  params = [],
  {
    retries = 2,
    delayMs = 200
  } = {}
) {
  try {
    return await dbQuery(sql, params);
  } catch (err) {
    const retryableErrors = [
      "ECONNRESET",
      "PROTOCOL_CONNECTION_LOST",
      "ETIMEDOUT",
      "EPIPE"
    ];

    const shouldRetry =
      retryableErrors.includes(err.code) && retries > 0;

    if (!shouldRetry) {
      console.error("❌ DB Query Failed:", {
        code: err.code,
        message: err.message,
        sql
      });
      throw err;
    }

    console.warn(
      `⚠️ DB error (${err.code}). Retrying in ${delayMs}ms... (${retries} left)`
    );

    // Delay (simple backoff)
    await new Promise(res => setTimeout(res, delayMs));

    return safeQuery(sql, params, {
      retries: retries - 1,
      delayMs: delayMs * 2 // exponential backoff
    });
  }
}
// -----------------------------------------------------
// AI GENERATION ENDPOINT
// -----------------------------------------------------
app.post("/generate", async (req, res) => {
    try {
        const { prompt } = req.body;
        
        if (!prompt) {
            return res.status(400).json({ 
                success: false, 
                error: "Prompt is required" 
            });
        }

        console.log(`\n=== /generate REQUEST ===`);
        console.log(`Prompt: "${prompt}"`);

        // Prepare data for N8N
        const n8nData = {
            // Coba format yang berbeda-beda
            agent_type: "automation",
            message: prompt,
            task: "generate",
            original_prompt: prompt,
            system_instruction: "Generate structured content using WasteVantage rules.",
            source: "generate_endpoint",
            timestamp: new Date().toISOString(),
            
            // Tambahkan semua field dari request asli
            ...req.body
        };

        // Coba panggil N8N
        const n8nResult = await callN8NWebhook(n8nData, "ihubs_chat");
        
        if (n8nResult.success && n8nResult.data) {
            console.log(`✅ N8N response successful`);
            
            // Cek berbagai kemungkinan field response
            const output = n8nResult.data.reply || 
                          n8nResult.data.output || 
                          n8nResult.data.message ||
                          n8nResult.data.content ||
                          "Generated content from N8N";
            
            return res.json({
                success: true,
                output: output,
                source: 'n8n',
                n8n_response: n8nResult.data,
                raw_n8n_status: n8nResult.status
            });
        }
        
        console.log(`⚠️ N8N failed, using fallback`);
        
        // Fallback
        return res.json({
            success: true,
            output: `Based on: "${prompt}", I've processed your generation request.`,
            source: 'fallback',
            n8n_status: 'no_valid_response',
            note: "N8N responded but no valid output field found"
        });

    } catch (err) {
        console.error("❌ /generate Error:", err);
        
        res.json({
            success: false,
            error: err.message,
            stack: err.stack
        });
    }
});

app.post("/test-n8n-format", async (req, res) => {
    const { format } = req.body;
    
    const testData = {
        timestamp: new Date().toISOString(),
        test: "format_test"
    };
    
    // Coba format yang berbeda
    if (format === 'simple') {
        testData.message = "Test message";
        testData.agent_type = "general";
    } else if (format === 'chat') {
        testData.agent_type = "sales";
        testData.message = "Test sales inquiry";
        testData.user_name = "Test User";
    } else if (format === 'generate') {
        testData.task = "generate";
        testData.prompt = "Test generation prompt";
        testData.agent_type = "automation";
    }
    
    console.log(`\n=== Testing N8N format: ${format} ===`);
    console.log("Sending:", JSON.stringify(testData, null, 2));
    
    const result = await callN8NWebhook(testData, "ihubs_chat");
    
    res.json({
        test_format: format,
        sent_data: testData,
        n8n_result: result
    });
});

// -----------------------------------------------------
// CORS OPTIONS HANDLING
// -----------------------------------------------------
app.options("/livechat/admin/stream", (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Cache-Control, Accept");
    res.status(200).end();
});

app.options("/livechat/stream", (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Cache-Control, Accept");
    res.status(200).end();
});

// -----------------------------------------------------
// LIVE CHAT ENDPOINTS (Updated with timeout support)
// -----------------------------------------------------

// Create Session with timeout info
app.post("/livechat/request", (req, res) => {
    const {
        name = "Guest",
        email = "",
        requestedRole = "support",
        initialMessages = []
    } = req.body;

    const sessionId = uuid();
    const safeName = name && name !== "null" ? name : "Guest";
    const safeEmail = email || "";

    /* =========================
       1️⃣ CREATE SESSION (MEMORY)
    ========================= */
    sessions[sessionId] = {
        id: sessionId,
        userName: safeName,
        userEmail: safeEmail,
        requestedRole: requestedRole.toLowerCase(),
        agentName: null,
        messages: [...initialMessages],
        createdAt: new Date(),
        lastActivity: new Date(),
        status: "waiting",
        timeoutAt: new Date(Date.now() + SESSION_CLAIM_TIMEOUT),
        warningSent: false
    };

    /* =========================
       2️⃣ INSERT DB (WAJIB)
    ========================= */
    db.query(
        `INSERT INTO chatbot_conversations_liveagent
         (session_id, client_name, client_email, conversation_text, created_at, status)
         VALUES (?, ?, ?, '', NOW(), 'active')`,
        [sessionId, safeName, safeEmail],
        (err) => {
            if (err) {
                console.error("❌ DB create conversation error:", err.message);
            }
        }
    );

    /* =========================
       3️⃣ 🔔 PUSH NOTIFICATION (DATA ONLY — WAJIB)
    ========================= */
    db.query(
        "SELECT fcm_token FROM admin_push_tokens",
        async (err, rows) => {
            if (err) {
                console.error("❌ Failed to fetch FCM tokens:", err.message);
                return;
            }

            if (!rows || rows.length === 0) {
                console.log("⚠️ No admin FCM tokens registered");
                return;
            }

            console.log(`📲 Sending DATA push to ${rows.length} admins`);

            for (const row of rows) {
                try {
                    await admin.messaging().send({
                        token: row.fcm_token,
                        data: {
                            title: "📞 Incoming Live Chat",
                            body: `${safeName} wants ${requestedRole} support`,
                            session_id: sessionId,              // ✅ SAMA DENGAN SW
                            requestedRole: requestedRole.toLowerCase(),
                            type: "incoming_call"
                        }
                    });
                } catch (e) {
                    console.error("❌ Push failed:", e.message);
                }
            }
        }
    );

    /* =========================
       4️⃣ SSE NOTIFY ADMINS (TAB AKTIF)
    ========================= */
    notifyAdmins({
        type: "new_session",
        sessionId,
        userName: safeName,
        userEmail: safeEmail,
        requestedRole: requestedRole.toLowerCase(),
        timestamp: new Date().toISOString(),
        timeoutIn: SESSION_CLAIM_TIMEOUT / 1000
    });

    /* =========================
       5️⃣ RESPONSE KE CLIENT
    ========================= */
    res.json({
        sessionId,
        timeout: SESSION_CLAIM_TIMEOUT / 1000,
        message: "Live agent session created. Waiting for agent assignment..."
    });
});


// Endpoint untuk menerima rating
app.post('/livechat/rating', (req, res) => {
    let { sessionId, rating, ratingType } = req.body;

    // ===============================
    // SAFETY NORMALIZATION
    // ===============================
    const VALID = ['Good', 'Needs Improvement', 'Not Rated'];

    if (!VALID.includes(rating)) rating = 'Not Rated';
    if (!VALID.includes(ratingType)) ratingType = 'Not Rated';

    db.query(
        `UPDATE chatbot_conversations_liveagent
         SET rating = ?,
             rating_type = ?
         WHERE session_id = ?`,
        [rating, ratingType, sessionId],
        (err) => {
            if (err) {
                console.error('❌ DB rating error:', err.message);
                return res.status(500).json({ success: false });
            }

            db.query(
                `INSERT INTO chatbot_session_logs
                 (session_id, action, details, timestamp)
                 VALUES (?, 'rating', ?, NOW())`,
                [sessionId, rating],
                () => {}
            );

            res.json({ success: true });
        }
    );
});



app.get('/livechat/session/:sessionId/agent', (req, res) => {
    const { sessionId } = req.params;
    
    console.log(`🔍 Getting agent name for session: ${sessionId}`);
    
    try {
        // CEK DARI MEMORY TERLEBIH DAHULU
        if (sessions[sessionId] && sessions[sessionId].agentName) {
            console.log(`✅ Found agent in memory: ${sessions[sessionId].agentName}`);
            return res.json({
                success: true,
                agentName: sessions[sessionId].agentName,
                sessionId: sessionId
            });
        }
        
        // JIKA TIDAK ADA DI MEMORY, CEK DATABASE
        console.log(`🔍 Agent not found in memory, checking database...`);
        db.query(
            `SELECT agent_name FROM chatbot_conversations_liveagent 
             WHERE session_id = ?`,
            [sessionId],
            (err, results) => {
                if (err) {
                    console.error('❌ Database error:', err.message);
                    return res.status(500).json({ 
                        success: false, 
                        error: 'Database error' 
                    });
                }
                
                if (results.length > 0 && results[0].agent_name) {
                    console.log(`✅ Found agent in database: ${results[0].agent_name}`);
                    return res.json({
                        success: true,
                        agentName: results[0].agent_name,
                        sessionId: sessionId
                    });
                }
                
                // JIKA TIDAK DITEMUKAN
                console.log(`❌ Agent name not found for session: ${sessionId}`);
                res.json({
                    success: false,
                    message: 'Agent name not found for this session'
                });
            }
        );
        
    } catch (error) {
        console.error('❌ Error in getAgentNameFromServer:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});



// Client SSE Stream with timeout support
app.get('/livechat/stream', (req, res) => {
    const sessionId = req.query.sessionId;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID required' });
    }

    console.log(`🔗 Client connected to SSE: ${sessionId}`);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send current session status
    if (sessions[sessionId]) {
        const session = sessions[sessionId];
        const timeRemaining = Math.max(0, SESSION_CLAIM_TIMEOUT - (Date.now() - new Date(session.createdAt).getTime()));
        
        res.write(`data: ${JSON.stringify({ 
            type: 'connected', 
            sessionId,
            timeRemaining: Math.ceil(timeRemaining / 1000),
            status: session.status
        })}\n\n`);
    } else {
        res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);
    }

    if (!clientConnections[sessionId]) {
        clientConnections[sessionId] = [];
    }
    clientConnections[sessionId].push(res);

    const heartbeat = setInterval(() => {
        if (res.writableEnded) {
            clearInterval(heartbeat);
            return;
        }
        res.write(`data: ${JSON.stringify({ 
            type: 'heartbeat', 
            timestamp: Date.now(),
            sessionStatus: sessions[sessionId] ? sessions[sessionId].status : 'unknown'
        })}\n\n`);
    }, 30000);

    req.on('close', () => {
        console.log(`🔌 Client SSE connection closed: ${sessionId}`);
        clearInterval(heartbeat);
        
        if (clientConnections[sessionId]) {
            clientConnections[sessionId] = clientConnections[sessionId].filter(conn => conn !== res);
            if (clientConnections[sessionId].length === 0) {
                delete clientConnections[sessionId];
            }
        }
    });
});

// Admin SSE Stream with timeout notifications
app.get("/livechat/admin/stream", (req, res) => {
    console.log("🖥️ Admin dashboard connecting to SSE stream");

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control, Content-Type, Accept",
        "Access-Control-Expose-Headers": "Content-Type, Cache-Control",
        "X-Accel-Buffering": "no"
    });

    const clientId = Math.random().toString(36).substring(7);
    console.log(`Admin client connected: ${clientId}`);

    res.write(`data: ${JSON.stringify({ 
        type: "admin_connected", 
        message: "SSE Connected Successfully",
        clientId,
        timestamp: new Date().toISOString()
    })}\n\n`);

    const sendInitialData = () => {
        try {
            const waitingSessions = Object.values(sessions).filter(s => !s.agentName && s.status !== 'timed_out');
            const timedOutSessions = Object.values(sessions).filter(s => s.status === 'timed_out');
            
            // Calculate time remaining for each waiting session
            const sessionsWithTime = waitingSessions.map(session => {
                const timeRemaining = Math.max(0, SESSION_CLAIM_TIMEOUT - (Date.now() - new Date(session.createdAt).getTime()));
                return {
                    ...session,
                    timeRemaining: Math.ceil(timeRemaining / 1000)
                };
            });
            
            res.write(`data: ${JSON.stringify({ 
                type: "initial_data", 
                waitingSessions: waitingSessions.length,
                timedOutSessions: timedOutSessions.length,
                totalSessions: Object.keys(sessions).length,
                sessions: sessionsWithTime,
                clientId
            })}\n\n`);
        } catch (error) {
            console.log('Initial data send failed');
        }
    };

    const heartbeatInterval = setInterval(() => {
        try {
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ 
                    type: "heartbeat", 
                    clientId,
                    timestamp: Date.now(),
                    adminConnections: adminClients.length
                })}\n\n`);
            }
        } catch (error) {
            console.log(`💔 Heartbeat failed for client ${clientId}`);
            clearInterval(heartbeatInterval);
        }
    }, 25000);

    setTimeout(sendInitialData, 100);

    adminClients.push(res);

    req.on("close", () => {
        console.log(`📴 Admin client disconnected: ${clientId}`);
        clearInterval(heartbeatInterval);
        const index = adminClients.indexOf(res);
        if (index !== -1) {
            adminClients.splice(index, 1);
            console.log(`Remaining admin connections: ${adminClients.length}`);
        }
    });

    req.on("error", (err) => {
        console.log(`❌ Admin stream error for ${clientId}:`, err.message);
        clearInterval(heartbeatInterval);
        const index = adminClients.indexOf(res);
        if (index !== -1) adminClients.splice(index, 1);
    });
});

// Send Message
app.post('/livechat/send', (req, res) => {
    try {
        const { sessionId, text, from, name } = req.body;

        if (!sessionId || !text) {
            return res.status(400).json({ error: 'Session ID and text are required' });
        }

        if (!sessions[sessionId]) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const senderName =
            from === 'agent'
                ? (sessions[sessionId].agentName || 'Agent')
                : (sessions[sessionId].userName || 'Guest');

        const line =
            `[${senderName} - ${new Date().toLocaleString()}] ${text}\n`;

        // 1️⃣ APPEND KE conversation_text
        db.query(
            `UPDATE chatbot_conversations_liveagent
             SET conversation_text = CONCAT(IFNULL(conversation_text,''), ?)
             WHERE session_id = ?`,
            [line, sessionId],
            (err) => {
                if (err) {
                    console.error('❌ DB append conversation error:', err.message);
                }
            }
        );

        // 2️⃣ LOG KE session_logs
        db.query(
            `INSERT INTO chatbot_session_logs
             (session_id, action, details, timestamp)
             VALUES (?, 'message', ?, NOW())`,
            [sessionId, `${senderName}: ${text}`],
            () => {}
        );

        // === LOGIC CHAT LAMA (TETAP) ===
        const message = {
            from,
            text,
            timestamp: new Date().toISOString(),
            name: senderName
        };

        sessions[sessionId].messages.push(message);
        sessions[sessionId].lastActivity = Date.now();

        if (from === 'user') {
            notifyAdmins({
                type: "message",
                sessionId,
                from: 'user',
                text,
                userName: senderName,
                timestamp: new Date().toISOString()
            });
        }

        if (from === 'agent' && clientConnections[sessionId]) {
            clientConnections[sessionId].forEach(res => {
                try {
                    res.write(`data: ${JSON.stringify(message)}\n\n`);
                } catch {}
            });
        }

        res.json({ success: true });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Test Message to Admin
app.post("/test-message-to-admin", (req, res) => {
    const { sessionId, text = "Test message" } = req.body;
    
    console.log("🔧 TEST: Sending direct message to admins");
    
    if (!sessionId) {
        return res.status(400).json({ error: "Session ID required" });
    }
    
    let sentCount = 0;
    adminClients.forEach((adminRes, index) => {
        try {
            if (!adminRes.writableEnded && adminRes.writable) {
                const testMessage = {
                    type: "message",
                    sessionId: sessionId,
                    from: "user", 
                    text: text,
                    name: "Test User",
                    timestamp: new Date().toISOString(),
                    message: text,
                    test: true
                };
                
                adminRes.write(`data: ${JSON.stringify(testMessage)}\n\n`);
                sentCount++;
                console.log(`✅ TEST sent to admin ${index}`);
            }
        } catch (error) {
            console.log(`❌ TEST failed for admin ${index}:`, error.message);
        }
    });
    
    res.json({ 
        success: true, 
        message: `Test message sent to ${sentCount} admins`,
        adminConnections: adminClients.length,
        sentTo: sentCount
    });
});

// Admin Send Message to Client
app.post('/livechat/admin-send', async (req, res) => {
    try {
        const { sessionId, text, agentName } = req.body;
        
        if (!sessionId || !text) {
            return res.status(400).json({ error: 'Session ID and text are required' });
        }

        console.log(`👨‍💼 Admin message for session ${sessionId}: ${text}`);

        if (!sessions[sessionId]) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        const message = {
            from: 'agent',
            text: text,
            timestamp: new Date().toISOString(),
            name: agentName || 'Agent'
        };
        
        sessions[sessionId].messages.push(message);
        sessions[sessionId].lastActivity = Date.now();

        pushToClients(sessionId, message);

        res.json({ success: true, message: 'Message sent to client' });

    } catch (error) {
        console.error('❌ Error sending admin message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Admin Claims Session
app.post("/livechat/claim", (req, res) => {
    const { sessionId, agentName, agentRole } = req.body;

    console.log(`Claiming session ${sessionId} by ${agentName} (${agentRole})`);

    // 1️⃣ VALIDASI SESSION
    if (!sessions[sessionId]) {
        return res.status(400).json({ error: "Invalid session" });
    }

    // 2️⃣ CEK TIMEOUT
    if (sessions[sessionId].status === 'timed_out') {
        return res.status(400).json({ 
            error: "Session has already timed out. Please ask the user to start a new session." 
        });
    }

    // 3️⃣ CEK SUDAH DICLAIM
    if (sessions[sessionId].agentName) {
        return res.status(400).json({ 
            error: "Session already claimed by another agent" 
        });
    }

    // 4️⃣ SIMPAN KE MEMORY (WAJIB)
    sessions[sessionId].agentName = agentName;
    sessions[sessionId].assignedRole = agentRole.toLowerCase();
    sessions[sessionId].lastActivity = new Date();
    sessions[sessionId].status = 'claimed';
    sessions[sessionId].claimedAt = new Date().toISOString();

    // 5️⃣ UPDATE TABLE UTAMA (🔥 AUTO SAVE AGENT)
    db.query(
        `UPDATE chatbot_conversations_liveagent
         SET agent_name = ?,
             status = 'claimed'
         WHERE session_id = ?
           AND agent_name IS NULL`,
        [agentName, sessionId],
        (err) => {
            if (err) {
                console.error('❌ DB claim update error:', err.message);
            }
        }
    );

    // 6️⃣ LOG KE SESSION LOGS
    db.query(
        `INSERT INTO chatbot_session_logs
         (session_id, action, details, timestamp)
         VALUES (?, 'claim', ?, NOW())`,
        [sessionId, `Claimed by ${agentName} (${agentRole})`],
        () => {}
    );

    // 7️⃣ NOTIFY ADMIN LAIN
    notifyAdmins({
        type: "assigned",
        sessionId,
        agentName,
        agentRole: agentRole.toLowerCase(),
        userName: sessions[sessionId].userName,
        requestedRole: sessions[sessionId].requestedRole,
        timestamp: new Date().toISOString()
    });

    // 8️⃣ NOTIFY CLIENT (SSE)
    if (clientConnections[sessionId]) {
        clientConnections[sessionId].forEach(clientRes => {
            try {
                clientRes.write(`data: ${JSON.stringify({
                    type: 'agent_connected',
                    message: `Connected to ${agentName} from ${agentRole} team`,
                    agentName: agentName,
                    timestamp: new Date().toISOString()
                })}\n\n`);
            } catch (error) {
                console.log('❌ Failed to notify client about agent connection');
            }
        });
    }

    // 9️⃣ WELCOME MESSAGE (TETAP SEPERTI SEKARANG)
    const welcomeMsg = {
        from: "agent",
        text: `Hello, I'm ${agentName} from the ${agentRole} team. How can I help you today?`,
        timestamp: new Date().toISOString()
    };

    sessions[sessionId].messages.push(welcomeMsg);
    pushToClients(sessionId, welcomeMsg);

    // 🔟 RESPONSE
    res.json({ 
        success: true,
        message: "Session claimed successfully"
    });
});

// Get Sessions with timeout info
app.get("/livechat/sessions", (req, res) => {
    const { role, includeTimedOut = false } = req.query;
    
    let filteredSessions = Object.values(sessions);
    
    // Filter by role if specified
    if (role && role !== 'all') {
        filteredSessions = filteredSessions.filter(
            session => session.requestedRole === role.toLowerCase()
        );
    }
    
    // Exclude timed out sessions unless specifically requested
    if (includeTimedOut !== 'true') {
        filteredSessions = filteredSessions.filter(session => session.status !== 'timed_out');
    }
    
    // Filter out claimed sessions if we're looking for waiting sessions
    const waitingOnly = req.query.waiting === 'true';
    if (waitingOnly) {
        filteredSessions = filteredSessions.filter(session => !session.agentName);
    }

    const list = filteredSessions.map((s) => {
        const sessionAge = Date.now() - new Date(s.createdAt).getTime();
        const timeRemaining = Math.max(0, SESSION_CLAIM_TIMEOUT - sessionAge);
        
        return {
            id: s.id,
            userName: s.userName,
            agentName: s.agentName,
            requestedRole: s.requestedRole,
            assignedRole: s.assignedRole,
            messagesCount: s.messages.length,
            lastMessage: s.messages[s.messages.length - 1] || null,
            createdAt: s.createdAt,
            lastActivity: s.lastActivity,
            status: s.status,
            timeRemaining: Math.ceil(timeRemaining / 1000),
            isUrgent: timeRemaining <= 30000, // 30 seconds remaining
            timeoutAt: s.timeoutAt || new Date(new Date(s.createdAt).getTime() + SESSION_CLAIM_TIMEOUT)
        };
    });

    console.log(`Returning ${list.length} sessions for role: ${role || 'all'}`);
    res.json(list);
});

// Get Session by ID
app.get("/livechat/session/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: "Session not found" });
    }
    
    const session = sessions[sessionId];
    const sessionAge = Date.now() - new Date(session.createdAt).getTime();
    const timeRemaining = Math.max(0, SESSION_CLAIM_TIMEOUT - sessionAge);

    res.json({
        ...session,
        timeRemaining: Math.ceil(timeRemaining / 1000),
        isUrgent: timeRemaining <= 30000,
        minutesWaiting: Math.floor(sessionAge / 60000)
    });
});

// Chat History
app.get("/livechat/history/:sessionId", (req, res) => {
    const id = req.params.sessionId;

    if (!sessions[id]) {
        return res.status(404).json({ error: "Session not found" });
    }

    res.json(sessions[id].messages);
});

// -----------------------------------------------------
// CLOSE SESSION (cleanup)
// -----------------------------------------------------
app.post('/livechat/close', (req, res) => {
    const { sessionId } = req.body;

    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Session not found' });
    }

    // update main table
    db.query(
        `UPDATE chatbot_conversations_liveagent
         SET ended_at = NOW(),
             status = 'ended'
         WHERE session_id = ?`,
        [sessionId],
        (err) => {
            if (err) {
                console.error('❌ DB close error:', err.message);
            }
        }
    );

    // log
    db.query(
        `INSERT INTO chatbot_session_logs
         (session_id, action, details, timestamp)
         VALUES (?, 'close', 'Session closed by agent', NOW())`,
        [sessionId],
        () => {}
    );

    // notify client
    if (clientConnections[sessionId]) {
        clientConnections[sessionId].forEach(res => {
            try {
                res.write(`data: ${JSON.stringify({
                    type: 'session_closed',
                    timestamp: new Date().toISOString()
                })}\n\n`);
            } catch {}
        });
    }

    delete sessions[sessionId];
    delete clientConnections[sessionId];

    res.json({ success: true });
});


// -----------------------------------------------------
// END SESSION (Admin ends chat)
// -----------------------------------------------------
    app.post("/livechat/end-session", (req, res) => {
    const { sessionId, agentName = "Admin", agentRole = "support", reason = "Chat ended by agent" } = req.body;

    console.log(`👋 End session requested: ${sessionId} by ${agentName}`);

    if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
    }

    if (!sessions[sessionId]) {
        return res.status(404).json({ error: "Session not found" });
    }

    const session = sessions[sessionId];
    const userName = session.userName || 'Guest';

    // Notify client if still connected
    if (clientConnections[sessionId]) {
        clientConnections[sessionId].forEach(clientRes => {
            try {
                clientRes.write(`data: ${JSON.stringify({
                    type: 'agent_ended',
                    message: `👋 ${agentName} (${agentRole}) has ended the chat. Thank you for contacting us!`,
                    reason: reason
                })}\n\n`);
            } catch (error) {
                // Ignore errors
            }
        });
    }

    // Clean up
    delete sessions[sessionId];
    delete clientConnections[sessionId];

    // Notify admins
    notifyAdmins({
        type: "session_ended",
        sessionId,
        userName,
        endedBy: agentName,
        reason: reason,
        timestamp: new Date().toISOString()
    });

    res.json({ 
        success: true, 
        message: "Session ended successfully",
        notification: `User ${userName} has been notified that the chat ended`
    });
});

// Transfer Session
app.post("/livechat/transfer", (req, res) => {
    const { sessionId, targetRole, transferredBy } = req.body;

    if (!sessions[sessionId]) {
        return res.status(404).json({ error: "Session not found" });
    }

    const validRoles = ["sales", "consultant", "support", "account"];
    if (!validRoles.includes(targetRole.toLowerCase())) {
        return res.status(400).json({ error: "Invalid target role" });
    }

    const oldRole = sessions[sessionId].requestedRole;
    sessions[sessionId].requestedRole = targetRole.toLowerCase();
    sessions[sessionId].agentName = null;
    sessions[sessionId].lastActivity = new Date();

    notifyAdmins({
        type: "session_transferred",
        sessionId,
        userName: sessions[sessionId].userName,
        fromRole: oldRole,
        toRole: targetRole,
        transferredBy,
        timestamp: new Date().toISOString()
    });

    res.json({ 
        success: true, 
        message: `Session transferred from ${oldRole} to ${targetRole}` 
    });
});

// Connection Test
app.get("/livechat/test-connection", (req, res) => {
    res.json({
        status: "ok",
        serverTime: new Date().toISOString(),
        sessions: Object.keys(sessions).length,
        adminConnections: adminClients.length,
        activeClientStreams: Object.keys(clientConnections).length,
        environment: process.env.NODE_ENV || 'development',
        message: "Live Chat Server is running correctly"
    });
});

// Health Check with timeout info
app.get("/health", (req, res) => {
    const waitingSessions = Object.values(sessions).filter(s => !s.agentName && s.status !== 'timed_out');
    const timedOutSessions = Object.values(sessions).filter(s => s.status === 'timed_out');
    
    res.json({ 
        status: "ok", 
        totalSessions: Object.keys(sessions).length,
        waitingSessions: waitingSessions.length,
        timedOutSessions: timedOutSessions.length,
        claimedSessions: Object.values(sessions).filter(s => s.agentName).length,
        adminClients: adminClients.length,
        activeClientStreams: Object.keys(clientConnections).length,
        uptime: process.uptime(),
        sessionTimeout: SESSION_CLAIM_TIMEOUT / 1000, // in seconds
        timestamp: new Date().toISOString()
    });
});

// Session Statistics with timeout data
app.get("/livechat/stats", (req, res) => {
    const sessionArray = Object.values(sessions);
    const now = Date.now();
    
    const stats = {
        total: sessionArray.length,
        byRole: {
            sales: sessionArray.filter(s => s.requestedRole === 'sales').length,
            consultant: sessionArray.filter(s => s.requestedRole === 'consultant').length,
            support: sessionArray.filter(s => s.requestedRole === 'support').length,
            account: sessionArray.filter(s => s.requestedRole === 'account').length
        },
        byStatus: {
            waiting: sessionArray.filter(s => !s.agentName && s.status !== 'timed_out').length,
            claimed: sessionArray.filter(s => s.agentName).length,
            timed_out: sessionArray.filter(s => s.status === 'timed_out').length
        },
        waiting: sessionArray.filter(s => !s.agentName && s.status !== 'timed_out').length,
        active: sessionArray.filter(s => s.agentName).length,
        adminConnections: adminClients.length,
        // Calculate average wait time for claimed sessions
        averageWaitTime: (() => {
            const claimedSessions = sessionArray.filter(s => s.agentName && s.claimedAt);
            if (claimedSessions.length === 0) return 0;
            
            const totalWaitTime = claimedSessions.reduce((total, session) => {
                const waitTime = new Date(session.claimedAt).getTime() - new Date(session.createdAt).getTime();
                return total + waitTime;
            }, 0);
            
            return Math.floor(totalWaitTime / claimedSessions.length / 1000); // in seconds
        })(),
        timestamp: new Date().toISOString()
    };

    res.json(stats);
});

// -----------------------------------------------------
// DEBUG ENDPOINTS (Updated with timeout support)
// -----------------------------------------------------

app.get("/debug/admin", (req, res) => {
    const sessionArray = Object.values(sessions);
    const now = Date.now();
    
    res.json({
        adminConnections: adminClients.length,
        sessions: sessionArray.length,
        sessionDetails: sessionArray.map(s => {
            const sessionAge = now - new Date(s.createdAt).getTime();
            const timeRemaining = Math.max(0, SESSION_CLAIM_TIMEOUT - sessionAge);
            
            return {
                id: s.id,
                userName: s.userName,
                requestedRole: s.requestedRole,
                agentName: s.agentName,
                messagesCount: s.messages.length,
                lastActivity: s.lastActivity,
                status: s.status,
                timeRemaining: Math.ceil(timeRemaining / 1000),
                createdAt: s.createdAt,
                timeoutAt: s.timeoutAt,
                warningSent: s.warningSent
            };
        })
    });
});

app.get("/debug/session/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: "Session not found" });
    }

    const session = sessions[sessionId];
    const sessionAge = Date.now() - new Date(session.createdAt).getTime();
    const timeRemaining = Math.max(0, SESSION_CLAIM_TIMEOUT - sessionAge);

    res.json({
        session: {
            ...session,
            timeRemaining: Math.ceil(timeRemaining / 1000),
            minutesWaiting: Math.floor(sessionAge / 60000)
        },
        hasClientStreams: !!clientConnections[sessionId],
        clientStreamCount: clientConnections[sessionId] ? clientConnections[sessionId].length : 0,
        adminClientCount: adminClients.length
    });
});

app.post("/debug/test-message", (req, res) => {
    const { sessionId, text, from = "client" } = req.body;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: "Session not found" });
    }

    const msg = {
        from,
        text: text || "Test message from debug endpoint",
        time: Date.now(),
        timestamp: new Date().toISOString()
    };

    sessions[sessionId].messages.push(msg);
    sessions[sessionId].lastActivity = new Date();
    
    pushToClients(sessionId, msg);

    notifyAdmins({
        type: "message",
        sessionId,
        from,
        text: msg.text,
        userName: sessions[sessionId].userName,
        requestedRole: sessions[sessionId].requestedRole,
        timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: "Test message sent" });
});

app.post("/debug/force-notify", (req, res) => {
    const { message = "Test notification" } = req.body;
    
    console.log("🔧 Sending forced notification to admins");
    
    notifyAdmins({
        type: "test_notification",
        message,
        timestamp: new Date().toISOString(),
        adminConnections: adminClients.length,
        testData: {
            sessionCount: Object.keys(sessions).length,
            activeSessions: Object.values(sessions).map(s => ({
                id: s.id,
                userName: s.userName,
                role: s.requestedRole,
                agent: s.agentName,
                status: s.status
            }))
        }
    });
    
    res.json({ 
        success: true, 
        message: "Forced notification sent",
        adminConnections: adminClients.length,
        activeSessions: Object.keys(sessions).length
    });
});

app.get("/debug/sessions", (req, res) => {
    const sessionList = Object.values(sessions).map(session => {
        const sessionAge = Date.now() - new Date(session.createdAt).getTime();
        const timeRemaining = Math.max(0, SESSION_CLAIM_TIMEOUT - sessionAge);
        
        return {
            id: session.id,
            userName: session.userName,
            requestedRole: session.requestedRole,
            agentName: session.agentName,
            messagesCount: session.messages.length,
            lastActivity: session.lastActivity,
            createdAt: session.createdAt,
            status: session.status,
            timeRemaining: Math.ceil(timeRemaining / 1000),
            isUrgent: timeRemaining <= 30000
        };
    });
    
    res.json({
        totalSessions: sessionList.length,
        sessions: sessionList,
        adminConnections: adminClients.length,
        sessionTimeout: SESSION_CLAIM_TIMEOUT / 1000, // in seconds
        timestamp: new Date().toISOString()
    });
});

app.post("/debug/send-test-to-admin", (req, res) => {
    const { sessionId, message = "Test message from debug" } = req.body;
    
    console.log("🔧 Sending test message to admins for session:", sessionId);
    
    if (!sessionId) {
        return res.status(400).json({ error: "Session ID required" });
    }
    
    const testPayload = {
        type: "message",
        sessionId: sessionId,
        from: "user",
        text: message,
        name: "Test User",
        userName: "Test User", 
        timestamp: new Date().toISOString(),
        message: message,
        debug: true
    };
    
    notifyAdmins(testPayload);
    
    res.json({ 
        success: true, 
        message: "Test message sent to admins",
        adminConnections: adminClients.length,
        payload: testPayload
    });
});

// Debug endpoint to check current state
app.get("/debug/chat-state", (req, res) => {
    res.json({
        server_time: new Date().toISOString(),
        database: {
            prompts_count: 'Run SELECT COUNT(*) FROM chatbot_prompts',
            sales_prompt: 'Run SELECT * FROM chatbot_prompts WHERE agent_type="sales" AND is_active=1'
        },
        endpoints: {
            test_sales: 'POST /n8n/get-prompt with {"agent_type": "sales"}',
            test_general: 'POST /n8n/get-prompt with {"agent_type": "general"}'
        },
        instructions: {
            step1: 'Check browser console for debug logs',
            step2: 'Test directly: curl -X POST https://livechat-backend-3sft.onrender.com/n8n/get-prompt -H "Content-Type: application/json" -d \'{"agent_type": "sales"}\'',
            step3: 'Check n8n workflow execution logs'
        }
    });
});

// -----------------------------------------------------
// ROOT ENDPOINT
// -----------------------------------------------------
app.get("/", (req, res) => {
    res.json({
        message: "iHub Combined Server (AI + Live Chat + Database)",
        version: "1.0.0",
        endpoints: {
            ai: {
                generate: "POST /generate",
                greeting: "GET /api/chat/greeting",
                updateGreeting: "POST /api/chat/update-greeting"
            },
            liveChat: {
                requestSession: "POST /livechat/request",
                clientSSE: "GET /livechat/stream?sessionId=ID",
                adminSSE: "GET /livechat/admin/stream",
                sendMessage: "POST /livechat/send",
                adminSend: "POST /livechat/admin-send",
                claimSession: "POST /livechat/claim",
                endSession: "POST /livechat/end-session",
                sessions: "GET /livechat/sessions",
                getMessages: "GET /livechat/session/:sessionId/messages",
                stats: "GET /livechat/stats",
                health: "GET /health"
            },
            debug: {
                admin: "GET /debug/admin",
                sessions: "GET /debug/sessions",
                testMessage: "POST /debug/test-message"
            }
        },
        features: {
            sessionTimeout: "2 minutes for unclaimed sessions",
            warnings: "30-second warning before timeout",
            sessionStatus: "waiting, claimed, timed_out"
        }
    });
});



app.get("/livechat/session/:sessionId/messages", (req, res) => {
    const sessionId = req.params.sessionId;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ 
            success: false, 
            error: 'Session not found' 
        });
    }
    
    const session = sessions[sessionId];
    
    res.json({
        success: true,
        sessionId: sessionId,
        userName: session.userName,
        agentName: session.agentName,
        status: session.status,
        messages: session.messages || [],
        createdAt: session.createdAt,
        lastActivity: session.lastActivity
    });
});

app.get('/admin/sessions', (req, res) => {
    const activeSessions = Object.values(sessions).map(session => ({
        id: session.id,
        userName: session.userName,
        userEmail: session.userEmail,
        requestedRole: session.requestedRole,
        status: session.status,
        waitingTime: Date.now() - session.createdAt
    }));
    
    res.json(activeSessions);
});


// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
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
















































