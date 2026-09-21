const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const upload = multer({ dest: 'uploads/' });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// التأكد من قراءة الملفات الثابتة من مجلد public
app.use(express.static('public'));
app.use(express.json());

// التوجيه المباشر للصفحة الرئيسية لتجنب خطأ Cannot GET /
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/chat', upload.single('image'), async (req, res) => {
    try {
        const prompt = req.body.prompt;
        // استقبال اسم النموذج من الواجهة، والافتراضي فلاش
        const selectedModel = req.body.model || 'gemini-1.5-flash';
        const model = genAI.getGenerativeModel({ model: selectedModel });

        let result;

        if (req.file) {
            const fileData = fs.readFileSync(req.file.path);
            const imagePart = {
                inlineData: {
                    data: fileData.toString("base64"),
                    mimeType: req.file.mimetype
                }
            };
            result = await model.generateContent([prompt || "اشرح لي هذه الصورة بالتفصيل", imagePart]);
            fs.unlinkSync(req.file.path); 
        } else {
            if (!prompt) {
                return res.status(400).json({ error: 'الرجاء إدخال نص أو إرفاق صورة.' });
            }
            result = await model.generateContent(prompt);
        }

        const responseText = result.response.text();
        res.json({ response: responseText });

    } catch (error) {
        console.error("API Error Details:", error);
        res.status(500).json({ error: error.message || 'حدث خطأ في الاتصال بنموذج الذكاء الاصطناعي.' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
