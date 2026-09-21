const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// إعداد مجلد مؤقت لاستقبال الصور (Screenshots)
const upload = multer({ dest: 'uploads/' });

// تهيئة مفتاح الذكاء الاصطناعي
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.static('public'));
app.use(express.json());

app.post('/api/chat', upload.single('image'), async (req, res) => {
    try {
        const prompt = req.body.prompt || "اشرح لي ما في هذه الصورة";
        // استخدام موديل فلاش لأنه سريع ويدعم الصور
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

        let result;

        if (req.file) {
            // إذا كان هناك صورة (سكرين شوت)
            const fileData = fs.readFileSync(req.file.path);
            const imagePart = {
                inlineData: {
                    data: fileData.toString("base64"),
                    mimeType: req.file.mimetype
                }
            };
            result = await model.generateContent([prompt, imagePart]);
            // مسح الصورة من السيرفر بعد معالجتها لتوفير المساحة
            fs.unlinkSync(req.file.path); 
        } else {
            // إذا كان نص فقط
            result = await model.generateContent(prompt);
        }

        const responseText = result.response.text();
        res.json({ response: responseText });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'حدث خطأ أثناء معالجة الطلب.' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
