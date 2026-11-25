/* SCWork V2.1.35 — sell-rate governance UI. No direct writes to any table.
 * All authoritative transitions are Supabase MFA+Owner-gated RPCs in migration 004.
 */
(()=>{
 'use strict';
 const $=id=>document.getElementById(id), guard=window.SCWORK_RATE_CARD_GUARD;
 if(!$('rateCardFile')||!guard)return;
 const session=()=>window.SCWORK_ADMIN_BRIDGE?.getSession()||{};
 const fmt=n=>new Intl.NumberFormat('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
 const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let pending=null,rows=[],live=null,profiles=[],busy=false,loaded=false;
 function note(text,type=''){const e=$('rateCardMessage');e.textContent=text;e.dataset.state=type;}
 const statusLabel={draft:'Draft · รอตรวจ',approved:'Approved · รอเผยแพร่',published:'Live',superseded:'History'};
 function render(){
  const owner=session().member?.role==='owner',editor=session().member?.role==='editor';
  $('rateCardLiveVersion').textContent=live?.version||'ยังไม่เผยแพร่';
  $('rateCardLiveDate').textContent=live?.published_at?new Date(live.published_at).toLocaleString('th-TH'):'ยังไม่มีราคาสาธารณะ';
  $('rateCardLiveMaterial').textContent=live?.card?.categories?.[0]?.materials?.length??'—';
  $('rateCardVersionCount').textContent=rows.length;
  const priorProfile=$('rateCardProfile').value;
  $('rateCardProfile').innerHTML='<option value="">เลือก Cost Profile ที่อนุมัติแล้ว</option>'+profiles.map(p=>`<option value="${safe(p.id)}">${safe(p.period_month)} · ${safe(p.status)}</option>`).join('');
  $('rateCardProfile').value=profiles.some(p=>p.id===priorProfile)?priorProfile:'';
  const options=rows.map(r=>`<option value="${safe(r.id)}">${safe(r.version)} · ${safe(statusLabel[r.status]||r.status)}</option>`).join('');
  const previous=$('rateCardSelected').value;
  $('rateCardSelected').innerHTML='<option value="">เลือกรายการเพื่ออนุมัติ / เผยแพร่ / ย้อนกลับ</option>'+options;
  $('rateCardSelected').value=rows.some(x=>x.id===previous)?previous:'';
  renderHistory();renderComparison();
  $('rateCardSubmit').disabled=busy||!(owner||editor)||!pending;
  actions();
 }
 function chosen(){return rows.find(x=>x.id===$('rateCardSelected').value)||null;}
 function actions(){
  const r=chosen(),owner=session().member?.role==='owner';
  $('rateCardApprove').disabled=busy||!owner||r?.status!=='draft';
  $('rateCardPublish').disabled=busy||!owner||r?.status!=='approved';
  $('rateCardRollback').disabled=busy||!owner||!r||!['approved','superseded'].includes(r.status)||!live;
  $('rateCardSubmit').disabled=busy||!pending||!['owner','editor'].includes(session().member?.role);
 }
 function brief(card){return (card?.categories?.[0]?.materials||[]).map(m=>({id:m.id,name:m.name,b2c:m.tiers?.[0]?.price??null,b2b:m.buyerRates?.company?.tiers?.[0]?.price??m.tiers?.[0]?.price??null,unit:m.mode==='area_sqm'?'บาท/ตร.ม.':'บาท/แผ่น A3+'}));}
 function renderComparison(){
  const test=pending||chosen()?.card;
  $('rateCardSelectedSummary').textContent=pending?'ไฟล์ที่จะเสนอขาย · '+pending.version:chosen()?'เวอร์ชันที่เลือก · '+chosen().version:'กรุณาเลือกไฟล์หรือเวอร์ชัน';
  const body=$('rateCardComparison');body.replaceChildren();
  if(!test){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='ยังไม่มี Rate Card สำหรับเปรียบเทียบ';tr.append(td);body.append(tr);return;}
  const previous=new Map(brief(live?.card).map(x=>[x.id,x]));
  for(const item of brief(test)){
   const p=previous.get(item.id),tr=document.createElement('tr');
   const rate=p?((item.b2c-p.b2c)/p.b2c)*100:null;
   const values=[item.name,item.unit,p?`฿${fmt(p.b2c)}`:'—',`฿${fmt(item.b2c)} / ฿${fmt(item.b2b)}`,
      rate===null?'ใหม่':(rate>0?'+':'')+fmt(rate)+'%'];
   values.forEach((value,index)=>{const td=document.createElement(index===0?'th':'td');td.textContent=value;tr.append(td);});body.append(tr);
  }
  const oldIds=new Set(brief(test).map(x=>x.id));
  for(const p of brief(live?.card).filter(p=>!oldIds.has(p.id))){const tr=document.createElement('tr');
   [p.name,p.unit,`฿${fmt(p.b2c)}`,'ไม่อยู่ในเวอร์ชันใหม่','ปิดการแสดงราคา'].forEach((val,index)=>{const td=document.createElement(index===0?'th':'td');td.textContent=val;tr.append(td);});body.append(tr);}
 }
 function renderHistory(){
  const body=$('rateCardHistory');body.replaceChildren();
  if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='ยังไม่มี Rate Card — เริ่มจาก Pricing Master Export';tr.append(td);body.append(tr);return;}
  rows.forEach(r=>{
   const tr=document.createElement('tr');tr.className=r.status==='published'?'rate-row-live':'';
   [r.version,statusLabel[r.status]||r.status,String(r.card?.categories?.[0]?.materials?.length??0),new Date(r.created_at).toLocaleDateString('th-TH'),'ดูรายละเอียด'].forEach((v,i)=>{
    const cell=document.createElement(i===0?'th':'td');
    if(i===4){const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=v;b.addEventListener('click',()=>{$('rateCardSelected').value=r.id;renderComparison();actions();});cell.append(b);}
    else cell.textContent=v;tr.append(cell);
   });body.append(tr);
  });
 }
 async function load(){const {db,member}=session();if(!db||!member||busy)return;
  busy=true;note('กำลังตรวจประวัติ Rate Card และ Cost Profile จาก Supabase...');
  try{
   const [v,l,p]=await Promise.all([
    db.from('scwork_rate_card_versions').select('*',{count:'exact'}).order('created_at',{ascending:false}).limit(200),
    db.from('scwork_public_rate_card_live').select('version,card,published_at').eq('id',1).maybeSingle(),
    db.from('scwork_cost_profiles').select('id,period_month,status').eq('status','approved').order('period_month',{ascending:false}).limit(100)
   ]);
   if(v.error||l.error||p.error)throw (v.error||l.error||p.error);
   if((v.count??0)>200)throw Error('ข้อมูลเกิน 200 Releases ต้องทำ Pagination ก่อนสรุปประวัติ');
   rows=v.data||[];profiles=p.data||[];
   live=l.data?{...l.data,card:guard.validate(l.data.card)}:null;
   loaded=true;note(live?'โหลดสำเร็จ · เวอร์ชัน LIVE: '+live.version:'ยังไม่มี Public Rate Card ที่อนุมัติและเผยแพร่');
  }catch(e){rows=[];profiles=[];live=null;loaded=false;note('อ่านข้อมูล Phase 04 ไม่สำเร็จ: '+(e?.message||e)+' · ตรวจ SQL 004, Login/MFA และ Network','error');}
  finally{busy=false;render();}
 }
 async function upload(){const file=$('rateCardFile').files?.[0];pending=null;
  if(!file){render();return;}
  try{if(file.size>150000)throw Error('ไฟล์ใหญ่เกิน 150 KB');pending=guard.parseExport(await file.text());
   note('ไฟล์ผ่านโครงสร้าง Selling Rate ขั้นต้น: '+pending.version+' · ต้องผ่าน SQL Validation และ Owner Approval อีกครั้ง','success');
  }catch(e){note('ไฟล์นี้ไม่ใช่ Approved Public Selling Rate: '+(e.message||e),'error');}
  render();
 }
 async function action(kind){const {db,member}=session();if(!db||!member||busy)return;
  const r=chosen(),why=$('rateCardActionReason').value.trim();
  if(why.length<16){note('กรุณาระบุเหตุผลพร้อมเอกสารอ้างอิงอย่างน้อย 16 ตัวอักษร','error');return;}
  let rpc,args;
  if(kind==='submit'){
   if(!pending||!$('rateCardProfile').value){note('แนบ Approved Selling Rate Export และเลือก Cost Profile ที่อนุมัติแล้ว','error');return;}
   rpc='scwork_rate_card_submit';args={p_card:pending,p_cost_profile_id:$('rateCardProfile').value,p_reason:why};
  }else{
   if(!r){note('เลือกเวอร์ชันในรายการก่อน','error');return;}
   if(kind==='approve'){
    if(!$('rateCardMarginAck').checked){note('Owner ต้องยืนยันว่าได้ตรวจ Margin, Source และต้นทุนแยกแล้ว','error');return;}
    rpc='scwork_rate_card_approve';args={p_id:r.id,p_reason:why,p_ack:'MARGIN_VERIFIED'};
   }else if(kind==='publish'){
    if(!window.confirm(`เผยแพร่เวอร์ชัน ${r.version} ให้ลูกค้าเห็นจริง? การอนุมัตินี้จะเปลี่ยนราคา LIVE ทันทีเมื่อ Public Loader เปิดอยู่`))return;
    rpc='scwork_rate_card_publish';args={p_id:r.id,p_reason:why};
   }else if(kind==='rollback'){
    if(!window.confirm(`Rollback กลับไปใช้เรทราคา ${r.version} โดยสร้าง RELEASE ใหม่ และเปลี่ยนราคา LIVE ทันที?`))return;
    rpc='scwork_rate_card_rollback';args={p_prior_id:r.id,p_reason:why};
   }
  }
  busy=true;actions();note('กำลังดำเนินการผ่าน Supabase Secure RPC...');
  try{
   const {error}=await db.rpc(rpc,args);if(error)throw error;
   if(kind==='submit'){$('rateCardFile').value='';pending=null;}
   $('rateCardActionReason').value='';$('rateCardMarginAck').checked=false;
   busy=false;await load();note(({submit:'บันทึก Draft แล้ว · ยังไม่เผยแพร่',approve:'Owner อนุมัติแล้ว · ยังไม่ LIVE',publish:'เผยแพร่ Selling Rate ที่ผ่าน Approval เป็น LIVE แล้ว',rollback:'Rollback เสร็จและสร้าง Version ใหม่พร้อม Audit แล้ว'})[kind],'success');
  }catch(e){note('ทำรายการไม่สำเร็จ: '+(e?.message||e),'error');busy=false;actions();}
 }
 $('rateCardFile').addEventListener('change',upload);
 $('rateCardSelected').addEventListener('change',()=>{renderComparison();actions();});
 for(const kind of ['Submit','Approve','Publish','Rollback'])$('rateCard'+kind).addEventListener('click',()=>action(kind.toLowerCase()));
 $('rateCardReload').addEventListener('click',load);
 window.addEventListener('scwork-admin-ready',load);
 window.addEventListener('scwork-admin-signout',()=>{pending=null;rows=[];live=null;profiles=[];loaded=false;busy=false;note('');render();});
 if(session().member)load();
 window.SCWORK_RATE_PUBLISHING={load};
})();
