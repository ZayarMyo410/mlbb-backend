const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8828334122:AAHsmbuBmbhiRHBNvk8CjbhflAjUZ96PUl8";
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "1745534669";

// 1. TELEGRAM ORDER API (Photo + Text + Buttons ကို တစ်ပေါင်းတည်း ပို့မည်)
app.post('/api/create-order', async (req, res) => {
    try {
        const { userId, zoneId, pkgName, price, payment, transId, slipBase64, customerChatId } = req.body;

        const textMessage = `🛒 *New Order Received!*\n------------------------\n🎮 *Player ID:* ${userId || 'N/A'} (${zoneId || 'N/A'})\n📦 *Item:* ${pkgName || 'N/A'}\n💰 *Price:* ${price || 'N/A'}\n💳 *Payment:* ${payment || 'N/A'}\n🔢 *Trans ID:* ${transId || 'N/A'}\n⏰ *Time:* ${new Date().toLocaleString()}`;

        // customerChatId ပါလာလျှင် သုံးမည်၊ မပါပါက transId ကို သုံးမည်
        const targetId = customerChatId || transId || 'order';

        const replyMarkup = JSON.stringify({
            inline_keyboard: [
                [
                    { text: "✅ Confirm", callback_data: `confirm_${targetId}` },
                    { text: "❌ Reject", callback_data: `reject_${targetId}` }
                ]
            ]
        });

        // Slip ပုံ ပါပါက ပုံ + Caption စာ + Confirm/Reject ခလုတ် ပို့မည်
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
            // Slip ပုံ မပါပါက စာတို + ခလုတ် ပို့မည်
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: ADMIN_CHAT_ID,
                text: textMessage,
                parse_mode: 'Markdown',
                reply_markup: JSON.parse(replyMarkup)
            });
        }

        res.json({ success: true, message: "Order processed successfully!" });
    } catch (error) {
        console.error("Telegram Send Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "Failed to send order to Telegram" });
    }
});

// 2. ORDER STATUS API
app.get('/api/order-status', (req, res) => {
    const { orderId } = req.query;
    res.json({
        orderId: orderId,
        status: "processing"
    });
});

// 3. OPENAI CHATBOT PROXY API
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

// 4. TELEGRAM CALLBACK QUERY HANDLER (Confirm / Reject နှိပ်ပါက တုံ့ပြန်ရန်)
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const { callback_query } = req.body;

        if (callback_query) {
            const callbackData = callback_query.data;
            const messageId = callback_query.message.message_id;
            const chatId = callback_query.message.chat.id;
            const originalText = callback_query.message.caption || callback_query.message.text || "";

            let statusText = "";
            let customerMessage = "";
            
            // confirm_ သို့မဟုတ် reject_ နောက်ကပါလာသော ID ကို ခွဲထုတ်ခြင်း
            const targetId = callbackData.split("_")[1];

            if (callbackData.startsWith("confirm_")) {
                statusText = "\n\n🟢 *STATUS: CONFIRMED BY ADMIN*";
                customerMessage = "🎉 သင်၏ Order အား အတည်ပြုလိုက်ပါပြီ။ ကျေးဇူးတင်ရှိပါသည်။";
            } else if (callbackData.startsWith("reject_")) {
                statusText = "\n\n🔴 *STATUS: REJECTED BY ADMIN*";
                customerMessage = "❌ သင်၏ Order အား ပယ်ဖျက်လိုက်ပါသည်။ အသေးစိတ်ကို Admin ထံ ဆက်သွယ်ပါ။";
            }

            // ၁။ ဝယ်သူ (Customer) ထံ Telegram စာပြန်ပို့ခြင်း (Chat ID ဂဏန်းအမှန် ပါဝင်ပါက)
            if (targetId && !isNaN(targetId)) {
                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: targetId,
                        text: customerMessage,
                        parse_mode: "Markdown"
                    });
                } catch (err) {
                    console.error("Customer ထံ စာပို့ရာတွင် Error တက်ပါသည်:", err.response?.data || err.message);
                }
            }

            // ၂။ Telegram ၏ Loading State ကို ပိတ်လိုက်မည်
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                callback_query_id: callback_query.id,
                text: "Order status updated!"
            });

            // ၃။ Admin Message ၏ Status ကို ပြင်ဆင်ပြီး ခလုတ်များကို ပျောက်သွားအောင်လုပ်မည်
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
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Callback Error:", error.response ? error.response.data : error.message);
        res.sendStatus(500);
    }
});

// 5. SERVER LISTEN
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}...`);
});
