const express = require('express');
const multer = require('multer');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

// สร้าง Express app
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());

// ตั้งค่า OpenAI API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY // ตั้งค่า API key ผ่าน environment variable
});

// ตั้งค่า Multer สำหรับอัปโหลดไฟล์
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // จำกัดขนาดไฟล์ 10MB
  fileFilter: (req, file, cb) => {
    // ตรวจสอบประเภทไฟล์
    if (!file.mimetype.match(/^image\/(jpeg|png|jpg)$/)) {
      return cb(new Error('อนุญาตเฉพาะไฟล์รูปภาพ (jpeg, jpg, png) เท่านั้น'), false);
    }
    cb(null, true);
  }
});

// Middleware สำหรับ JSON
app.use(express.json());

// API endpoint สำหรับการอัปโหลดและวิเคราะห์รูปภาพ
app.post('/analyze-accident', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'กรุณาอัปโหลดไฟล์รูปภาพ' });
    }

    const imagePath = req.file.path;
    
    // แปลงรูปภาพเป็น base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    // สร้าง prompt สำหรับวิเคราะห์
    const prompt = `นี่คือรูปภาพอุบัติเหตุ กรุณาวิเคราะห์ความรุนแรงของอุบัติเหตุในรูปภาพนี้ และจัดระดับความรุนแรงเป็นหนึ่งในสามระดับนี้: 
    - เบา: อุบัติเหตุเล็กน้อย มีความเสียหายต่อทรัพย์สินเล็กน้อย ไม่มีหรือมีการบาดเจ็บเล็กน้อย
    - กลาง: อุบัติเหตุที่มีความเสียหายปานกลาง อาจมีการบาดเจ็บที่ต้องการการรักษา
    - ร้ายแรง: อุบัติเหตุรุนแรง มีความเสียหายมาก มีการบาดเจ็บสาหัส หรืออาจมีผู้เสียชีวิต
    
    ให้ตอบในรูปแบบ JSON ดังนี้:
    {
      "jirawat": "เบา/กลาง/ร้ายแรง",
      "description": "คำอธิบายสั้นๆ เกี่ยวกับเหตุผลในการประเมิน",
      "recommendations": "คำแนะนำตามระดับความรุนแรง",
      "fixinglist" : [
        {tool : "ช่วยวิเคราะห์อุปกรร์ที่ต้องซ่อมหรือเปลี่ยนหรือจำเป็ต้องตรวจสอบและช่วยประเมินส่วนที่อาจจะได้ผลกรทบจากส่วนที่ได้รับความเสียหายที่เรามองไม่เห็นจากรูป" , status : "สถาณะว่าซ่อมหรือเปลี่ยน"}
      ],
    }`;

    // ใช้โมเดล GPT-4o ที่ทันสมัยแทน gpt-4-vision-preview ที่เลิกใช้งาน
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // ใช้โมเดล GPT-4o ล่าสุดที่รองรับการวิเคราะห์ภาพ
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "high" // ขอรายละเอียดระดับสูงสำหรับการวิเคราะห์
              }
            }
          ]
        }
      ],
      max_tokens: 500,
    });

    // ดึงข้อมูลจากการตอบกลับและแปลงเป็น JSON
    let result;
    try {
      const responseText = response.choices[0].message.content;
      // พยายามแยก JSON จากข้อความตอบกลับ
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        // ถ้าไม่สามารถแยก JSON ได้ ให้สร้างรูปแบบเอง
        result = {
          severity: "ไม่สามารถระบุได้",
          description: "ไม่สามารถวิเคราะห์จากภาพได้อย่างชัดเจน",
          recommendations: "แนะนำให้ตรวจสอบโดยผู้เชี่ยวชาญ",
          raw_response: responseText
        };
      }
    } catch (error) {
      console.error("Error parsing GPT response:", error);
      result = {
        severity: "ไม่สามารถระบุได้",
        description: "เกิดข้อผิดพลาดในการวิเคราะห์",
        recommendations: "แนะนำให้ตรวจสอบโดยผู้เชี่ยวชาญ",
        error: error.message
      };
    }

    // ลบไฟล์รูปภาพหลังจากวิเคราะห์เสร็จ (ตัวเลือก)
    fs.unlinkSync(imagePath);

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: `เกิดข้อผิดพลาด: ${error.message}` });
  }
});

// สร้าง API endpoint สำหรับการตรวจสอบสถานะ
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'ระบบทำงานปกติ' });
});

// เริ่มต้นเซิร์ฟเวอร์
app.listen(port, () => {
  console.log(`เซิร์ฟเวอร์ทำงานที่ http://localhost:${port}`);
});