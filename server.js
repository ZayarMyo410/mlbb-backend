const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8828334122:AAHsmbuBmbhiRHBNvk8CjbhflAjUZ96PUl8";
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "1745534669";
const SERVER_URL = "https://mlbb-backend-04am.onrender.com";

// Order Status များကို ခေတ္တ သိမ်းဆည်းထားရန် Object
const orderStore = {};

// 1. TELEGRAM WEBHOOK AUTO SET
async function setupWebhook() {
    try {
        const webhookUrl = `${SERVER_URL}/api/telegram-webhook`;
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, { url: webhookUrl });
        console.log("Telegram Webhook Successfully Set:", webhookUrl);
    } catch (err) {
        console.error("Webhook Setup Error:", err.message);
    }
}

// 2. TELEGRAM ORDER API
app.post('/api/create-order', async (req, res) => {
    try {
        const { userId, zoneId, pkgName, price, payment, transId, slipBase64, customerChatId } = req.body;

        const orderId = `GL-${Date.now().toString().slice(-6)}`;
        const targetId = customerChatId || "1745534669"; 

        // Order Status ကို စတင်သိမ်းဆည်းမည်
        orderStore[orderId] = { status: "processing", customerChatId: targetId };

        const textMessage = `🛒 *New Order Received!*\n------------------------\n🆔 *Order ID:* \`${orderId}\` \n🎮 *Player ID:* ${userId || 'N/A'} (${zoneId || 'N/A'})\n📦 *Item:* ${pkgName || 'N/A'}\n💰 *Price:* ${price || 'N/A'}\n💳 *Payment:* ${payment || 'N/A'}\n🔢 *Trans ID:* ${transId || 'N/A'}\n⏰ *Time:* ${new Date().toLocaleString()}`;

        const replyMarkup = JSON.stringify({
            inline_keyboard: [
                [
                    { text: "✅ Confirm", callback_data: `confirm_${orderId}` },
                    { text: "❌ Reject", callback_data: `reject_${orderId}` }
                ]
            ]
        });

        if (slipBase64) {
            const base64Data = slipBase64.replace(/^data:image\/\w+;base64,/, "");
            const imageBuffer = Buffer.from(base64Data, 'base64');
            
            const form = new FormData();
            form.append('chat_id', ADMIN_CHAT_ID);
            form.append('photo', imageBuffer, { filename: 'slip.jpg' });
            form.append('caption', textMessage);
            form.append('parse_mode', 'Markdown');
            form.append('reply_markup', replyMarkup);

            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, form, {
                headers: form.getHeaders()
            });
        } else {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: ADMIN_CHAT_ID,
                text: textMessage,
                parse_mode: 'Markdown',
                reply_markup: JSON.parse(replyMarkup)
            });
        }

        res.json({ success: true, orderId: orderId, message: "Order processed successfully!" });
    } catch (error) {
        console.error("Telegram Send Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "Failed to send order to Telegram" });
    }
});

// 3. ORDER STATUS API
app.get('/api/order-status', (req, res) => {
    const { orderId } = req.query;
    const orderData = orderStore[orderId];

    if (orderData) {
        res.json({ orderId: orderId, status: orderData.status });
    } else {
        res.json({ orderId: orderId, status: "processing" });
    }
});

// 4. OPENAI CHATBOT PROXY API
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

// 5. TELEGRAM CALLBACK QUERY HANDLER (WEBHOOK)
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const { callback_query } = req.body;

        if (callback_query) {
            // 🟢 1. Telegram Timeout မဖြစ်စေရန် အမြန်ဆုံး အကြောင်းပြန်ပါ
            try {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                    callback_query_id: callback_query.id,
                    text: "Order status updated!"
                });
            } catch (ansErr) {
                console.log("Answer Callback Expired:", ansErr.message);
            }

            const callbackData = callback_query.data;
            const messageId = callback_query.message.message_id;
            const chatId = callback_query.message.chat.id;
            let originalText = callback_query.message.caption || callback_query.message.text || "";

            const action = callbackData.split("_")[0];
            const orderId = callbackData.split("_")[1];

            let statusText = "";
            let customerMessage = "";
            let targetChatId = orderStore[orderId]?.customerChatId || "1745534669";

            if (action === "confirm") {
                statusText = "\n\n🟢 *STATUS: CONFIRMED BY ADMIN*";
                customerMessage = `🎉 *Order ID (${orderId})* အား အတည်ပြုလိုက်ပါပြီ။ Diamond များ ထည့်သွင်းပေးပြီးပါပြီခင်ဗျာ။`;
                
                if (orderStore[orderId]) {
                    orderStore[orderId].status = "completed";
                }
            } else if (action === "reject") {
                statusText = "\n\n🔴 *STATUS: REJECTED BY ADMIN*";
                customerMessage = `❌ *Order ID (${orderId})* အား ပယ်ဖျက်လိုက်ပါသည်။ အသေးစိတ်ကို Admin ထံ ဆက်သွယ်ပါခင်ဗျာ။`;
                
                if (orderStore[orderId]) {
                    orderStore[orderId].status = "rejected";
                }
            }

            // 🟢 2. ဝယ်သူထံ စာပို့ခြင်း
            if (targetChatId) {
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

            // 🟢 3. Admin စာတို/ပုံ၏ စာသားကို Status သို့ ပြောင်းလဲခြင်း
            try {
                if (callback_query.message.photo) {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageCaption`, {
                        chat_id: chatId,
                        message_id: messageId,
                        caption: originalText + statusText,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [] }
                    });
                } else {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                        chat_id: chatId,
                        message_id: messageId,
                        text: originalText + statusText,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [] }
                    });
                }
            } catch (editErr) {
                console.error("Edit Message Error:", editErr.response?.data || editErr.message);
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Callback Error:", error.response ? error.response.data : error.message);
        res.sendStatus(200); // Server Crash မဖြစ်စေရန် 200 သာ ပြန်ပေးပါမည်
    }
});

// 6. SERVER LISTEN
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}...`);
    setupWebhook();
});
