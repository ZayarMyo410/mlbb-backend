const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();

// 🟢 1. MONGODB CONNECT & COUNTER SCHEMA SETUP
const MONGODB_URI = process.env.MONGODB_URI || "your_mongodb_connection_string_here";

mongoose.connect(MONGODB_URI)
    .then(() => console.log("MongoDB Connected Successfully!"))
    .catch(err => console.error("MongoDB Connection Error:", err.message));

// Order Counter အတွက် Schema သတ်မှတ်ခြင်း
const counterSchema = new mongoose.Schema({
    id: { type: String, required: true },
    seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// Order ID အစဉ်လိုက် တိုးပေးမည့် Async Function
async function getNextSequence(sequenceName) {
    const counter = await Counter.findOneAndUpdate(
        { id: sequenceName },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return counter.seq;
}

// 🟢 CORS Options
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8828334122:AAHsmbuBmbhiRHBNvk8CjbhflAjUZ96PUl8";
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "1745534669";
const SERVER_URL = "https://mlbb-backend-04am.onrender.com";

const orderStore = {};

// 1. HEALTH CHECK / KEEP-ALIVE
app.get('/api/ping', (req, res) => {
    res.status(200).send("OK");
});

// 2. TELEGRAM WEBHOOK AUTO SET
async function setupWebhook() {
    try {
        const webhookUrl = `${SERVER_URL}/api/telegram-webhook`;
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, { url: webhookUrl });
        console.log("Telegram Webhook Successfully Set:", webhookUrl);
    } catch (err) {
        console.error("Webhook Setup Error:", err.message);
    }
}

// 3. TELEGRAM ORDER API (Database မှ Counter ယူမည်)
app.post('/api/create-order', async (req, res) => {
    try {
        const { userId, zoneId, pkgName, price, payment, transId, slipBase64, customerChatId } = req.body;

        // 🟢 MongoDB ထဲမှ Sequence ID တောင်းယူခြင်း (Restart ကျလည်း မပျောက်ပါ)
        const seqNumber = await getNextSequence("order_id");
        const formattedNumber = String(seqNumber).padStart(6, '0');
        const orderId = `GL-${formattedNumber}`;

        const targetId = customerChatId || null; 
        orderStore[orderId] = { status: "processing", customerChatId: targetId };

        res.status(200).json({ success: true, orderId: orderId, message: "Order processed successfully!" });

        setImmediate(async () => {
            try {
                const textMessage = `🛒 *New Order Received!*\n------------------------\n🆔 *Order ID:* \`${orderId}\` \n🎮 *Player ID:* ${userId || 'N/A'} (${zoneId || 'N/A'})\n📦 *Item:* ${pkgName || 'N/A'}\n💰 *Price:* ${price || 'N/A'}\n💳 *Payment:* ${payment || 'N/A'}\n🔢 *Trans ID:* ${transId || 'N/A'}\n⏰ *Time:* ${new Date().toLocaleString()}`;

                const replyMarkup = JSON.stringify({
                    inline_keyboard: [
                        [
                            { text: "✅ Confirm", callback_data: `confirm_${orderId}` },
                            { text: "❌ Reject", callback_data: `reject_${orderId}` }
                        ]
                    ]
                });

                if (slipBase64 && typeof slipBase64 === 'string' && slipBase64.includes('base64,')) {
                    const base64Data = slipBase64.split('base64,')[1];
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    
                    const form = new FormData();
                    form.append('chat_id', ADMIN_CHAT_ID);
                    form.append('photo', imageBuffer, { filename: 'slip.jpg' });
                    form.append('caption', textMessage);
                    form.append('parse_mode', 'Markdown');
                    form.append('reply_markup', replyMarkup);

                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, form, {
                        headers: form.getHeaders(),
                        timeout: 10000
                    });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: ADMIN_CHAT_ID,
                        text: textMessage,
                        parse_mode: 'Markdown',
                        reply_markup: JSON.parse(replyMarkup)
                    }, { timeout: 10000 });
                }
            } catch (bgError) {
                console.error("Background Telegram Send Error:", bgError.response ? bgError.response.data : bgError.message);
            }
        });
    } catch (err) {
        console.error("Order Creation Error:", err.message);
        res.status(500).json({ error: "Order Creation Failed" });
    }
});

// 4. ORDER STATUS API
app.get('/api/order-status', (req, res) => {
    const { orderId } = req.query;
    const orderData = orderStore[orderId];

    if (orderData) {
        res.json({ orderId: orderId, status: orderData.status });
    } else {
        res.json({ orderId: orderId, status: "processing" });
    }
});

// 5. OPENAI CHATBOT PROXY API
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            { model: 'gpt-4o-mini', messages: messages },
            { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` } }
        );
        res.json(response.data);
    } catch (error) {
        console.error("OpenAI API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "AI Response Failed" });
    }
});

// 6. TELEGRAM CALLBACK QUERY HANDLER (WEBHOOK)
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const { callback_query, message } = req.body;
if (message && message.text && message.text.startsWith('/start')) {
            const chatId = message.chat.id;
            const welcomeMessage = `မင်္ဂလာပါ 👋 Grand Line Diamonds Shop မှ ကြိုဆိုပါတယ်ခင်ဗျာ။\n\nDiamond များ ဝယ်ယူရန် အောက်ပါ Shop Now Button ကို နှိပ်၍ ဝယ်ယူနိုင်ပါတယ်။`;

            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: welcomeMessage,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "💎 Shop Now", web_app: { url: "https://mlbb-backend-04am.onrender.com" } }]
                    ]
                }
            });

            return res.sendStatus(200);
        }
        if (callback_query) {
            const callbackData = callback_query.data;
            const messageId = callback_query.message.message_id;
            const chatId = callback_query.message.chat.id;
            let originalText = callback_query.message.caption || callback_query.message.text || "";

            const action = callbackData.split("_")[0];
            const orderId = callbackData.split("_")[1];

            let adminStatusTag = "";
            let customerMessage = "";
            let targetChatId = orderStore[orderId]?.customerChatId || null;

            if (action === "confirm") {
                adminStatusTag = "\n\n🟢 *[CONFIRMED]*";
                customerMessage = `🎉 *Order ID (${orderId})* အား အတည်ပြုလိုက်ပါပြီ။ Diamond များ ထည့်သွင်းပေးပြီးပါပြီခင်ဗျာ။`;
                
                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                        callback_query_id: callback_query.id,
                        text: `Order ${orderId} Confirmed!`
                    });
                } catch (ansErr) {}

                if (orderStore[orderId]) {
                    orderStore[orderId].status = "completed";
                }
            } else if (action === "reject") {
                adminStatusTag = "\n\n🔴 *[REJECTED]*";
                customerMessage = `❌ *Order ID (${orderId})* အား ပယ်ဖျက်လိုက်ပါသည်။ အသေးစိတ်ကို Admin ထံ ဆက်သွယ်ပါခင်ဗျာ။`;
                
                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                        callback_query_id: callback_query.id,
                        text: `Order ${orderId} Rejected!`
                    });
                } catch (ansErr) {}

                if (orderStore[orderId]) {
                    orderStore[orderId].status = "rejected";
                }
            }

            // 🟢 ဝယ်သူ ID သီးသန့်ရှိပြီး Admin ID မဟုတ်မှသာ ဝယ်သူဆီ စာပို့မည်
            if (targetChatId && String(targetChatId) !== String(ADMIN_CHAT_ID) && String(targetChatId) !== String(chatId)) {
                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: targetChatId,
                        text: customerMessage,
                        parse_mode: "Markdown"
                    });
                } catch (err) {
                    console.error("Customer Msg Error:", err.response?.data || err.message);
                }
            }

            // 🟢 Admin Message အား Update လုပ်မည် (Button ပျောက်ပြီး Tag သာ ကျန်မည်)
            try {
                if (callback_query.message.photo) {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageCaption`, {
                        chat_id: chatId,
                        message_id: messageId,
                        caption: originalText + adminStatusTag,
                        parse_mode: 'Markdown',
                        reply_markup: JSON.stringify({ inline_keyboard: [] })
                    });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                        chat_id: chatId,
                        message_id: messageId,
                        text: originalText + adminStatusTag,
                        parse_mode: 'Markdown',
                        reply_markup: JSON.stringify({ inline_keyboard: [] })
                    });
                }
            } catch (editErr) {
                console.error("Edit Message Error:", editErr.response?.data || editErr.message);
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Callback Error:", error.response ? error.response.data : error.message);
        res.sendStatus(200);
    }
});

// 7. SERVER LISTEN
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}...`);
    setupWebhook();
});
