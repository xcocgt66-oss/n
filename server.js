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

app.use(express.static('public'));
app.use(express.json());

app.post('/api/chat', upload.single('image'), async (req, res) => {
    try {
        const prompt = req.body.prompt;
       // استبدل استدعاء النموذج بهذا الشكل:
        const selectedModel = req.body.model || 'gemini-2.0-flash';

        const model = genAI.getGenerativeModel(
            { model: selectedModel },
            { apiVersion: 'v1beta' }
        );
        
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
            result = await model.generateContent([prompt || "اشرح هذه الصورة بالتفصيل", imagePart]);
            fs.unlinkSync(req.file.path); // مسح الصورة بعد المعالجة
        } else {
            if (!prompt) return res.status(400).json({ error: 'يرجى كتابة رسالة.' });
            result = await model.generateContent(prompt);
        }

        const responseText = result.response.text();
        res.json({ response: responseText });

    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: error.message || 'حدث خطأ في الاتصال بالنموذج.' });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
