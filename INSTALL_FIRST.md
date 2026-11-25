# SCWork Admin — Cumulative Upgrade V2.1.32 → V2.1.35

ใช้กับ Vercel Project `scadmininkjet` และ GitHub Repository `ScAdmin-Source` โดยตั้ง Root Directory ของ Vercel เป็น `admin-deploy` ตามการตั้งค่าปัจจุบันที่ใช้งานได้

**เหตุที่รวมชุดใหม่:** V2.1.35 Phase 04 Patch เดิมเป็น incremental patch สำหรับระบบที่ติดตั้ง V2.1.34 แล้ว ไม่ใช่ไฟล์ครบสำหรับอัปเกรดตรงจาก V2.1.32 หากใช้เฉพาะ Patch นั้นหรืออัปโหลดผิดโฟลเดอร์ หน้าจอจะยังเป็นเวอร์ชันเดิม / ฟังก์ชันไม่ครบ

## สำคัญก่อนติดตั้ง

- Backup GitHub และฐานข้อมูล Supabase ก่อน ไม่แก้โค้ดบน Production โดยยังไม่ได้ตรวจการเปลี่ยนแปลง
- ยืนยันว่า Repo ที่เชื่อม Vercel คือ `somchais1113-ui/ScAdmin-Source`, branch `main`
- **เก็บ `admin-deploy/config.js` เดิม** ที่เชื่อม Supabase ไว้ ห้ามอัปโหลด URL/คีย์ลับลง GitHub (Publishable Key ออกแบบให้ใช้งานฝั่ง client ได้ แต่ RLS ต้องถูกต้อง)
- **เก็บ `admin-deploy/scwork-logo.png`, `pricing-utils.js`, `styles.css` และ `vercel.json` เดิม** โดยชุดนี้ไม่มีการทับ
- โครงสร้างใน ZIP ต้องถูกคัดลอกเป็นไฟล์ลงใน `ScAdmin-Source/admin-deploy/` ไม่ใช่เอาทั้งโฟลเดอร์ไปซ้อนเป็น `admin-deploy/admin-deploy/`
- ตรวจ SQL ที่ Staging ก่อน Production และตรวจว่า 002,003,004 เคยรันแล้วหรือไม่; **อย่ารันซ้ำโดยไม่ตรวจ idempotency**

## ขั้นอัปเดตเว็บ

1. แตก ZIP ชุดนี้
2. อัปโหลดไฟล์ทั้งหมดภายใน `admin-deploy/` ของ ZIP ไปยังโฟลเดอร์ `admin-deploy/` ใน GitHub (ห้ามลาก `admin-setup/` ไปไว้ในเว็บไซต์)
3. Commit บน `main` ด้วยข้อความ `Upgrade SCWork Admin to v2.1.35 (cumulative)`
4. ตรวจ Vercel > `scadmininkjet` > Deployments ว่า Commit ใหม่ขึ้น **READY Production**
5. เปิด `https://scadmininkjet.vercel.app/` แบบ hard reload / Incognito; มุมขวาบนต้องแสดง `v2.1.35` **ก่อน Login**
6. ถ้าระบุ `v2.1.32` ต่อไป ให้หยุดตรวจตำแหน่งไฟล์และ Commit ก่อน อย่าแก้ Supabase
7. ถ้าหน้า Version ถูกต้องแล้ว จึงเข้า Login/MFA และทดสอบแต่ละแท็บ

## SQL — ฐานข้อมูล

ฐานข้อมูล V2.1.32 ที่สร้างและมี owner อยู่แล้วจะไม่ถูกสร้างใหม่ในชุดนี้

- `002_scwork_cost_management.sql` สำหรับ Cost Master
- `003_scwork_job_profitability.sql` สำหรับ Job Profitability
- `004_scwork_rate_card_publishing.sql` สำหรับ Rate Card Publishing

รันตามลำดับ **เฉพาะรายการที่ยังไม่ได้ติดตั้ง** หลัง Backup และการทดสอบกับ Staging เท่านั้น ใช้ PRE/POST FLIGHT SQL สำหรับการอ่านผลตรวจ แต่ต้องตรวจข้อความและความเหมาะสมก่อนรันเสมอ

## Acceptance Test

- [ ] เปิดหน้า Login เห็น V2.1.35
- [ ] Email + Password + MFA ยังผ่าน
- [ ] Supplier Prices เดิมยังใช้งานได้
- [ ] Cost Management แสดงหน้าจอ (หาก SQL 002 ผ่าน)
- [ ] Job Profitability แสดงหน้าจอ (หาก SQL 003 ผ่าน)
- [ ] Rate Card & Publishing แสดงหน้าจอ (หาก SQL 004 ผ่าน)
- [ ] ไม่มีต้นทุน Supplier / ข้อมูลส่วนตัวส่งถึง Public API
- [ ] Owner/Editor/Viewer/Anonymous ถูกจำกัดสิทธิ์ตาม RLS
- [ ] ทดลอง Draft, Approval, Publish, Rollback ด้วยข้อมูลจำลองบน Staging ก่อนเปิดใช้จริง

**หมายเหตุ:** `READY` หมายความว่า Vercel Build เสร็จ ไม่ใช่หลักฐานยืนยันว่าระบบ SQL, RLS, Pricing และการ Publish ทำงานถูกต้องครบ
