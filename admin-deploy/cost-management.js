/* SCWork Cost Management 2.1.33. No writes to public selling-rate tables. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const E = window.SCWORK_COST_ENGINE;
  const ROLES = [
    ['design', 'ออกแบบ / Design'], ['prepress', 'เตรียมไฟล์ / Prepress'],
    ['coordination', 'ประสานงาน'], ['qc', 'ตรวจคุณภาพ / QC'],
    ['packing', 'แพ็กสินค้า'], ['production', 'งานผลิตภายใน']
  ];
  const CATEGORIES = [
    ['facility','ค่าเช่า / พื้นที่'], ['utilities','ค่าไฟสำนักงาน / สาธารณูปโภค'],
    ['software','Software / Cloud'], ['equipment','ค่าเสื่อม / อุปกรณ์'],
    ['indirect_salary','เงินเดือนบุคลากรทางอ้อม'], ['general','บริหารและค่าใช้จ่ายอื่น'],
    ['insurance','ประกันภัย / ค่าคุ้มครอง']
  ];
  const formatMoney = n => Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
  const formatPercent = n => (Number(n)*100).toLocaleString('th-TH',{maximumFractionDigits:2})+'%';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n = id => $(id).value.trim();
  const parse = id => { const v=n(id); if(v==='')throw Error('กรุณากรอก '+($(id).closest('label')?.textContent?.trim()||id));return Number(v); };
  const pct = id => parse(id)/100;
  let profiles=[], selectedId='', approvalId='', loaded=false, loadBusy=false;
  let draftBuffer=null;
  function current(){return window.SCWORK_ADMIN_BRIDGE?.getSession() || {};}
  function notify(text,kind='info') {const el=$('costMessage'); if(!el)return;el.textContent=text||'';el.dataset.kind=kind;}
  function setView(view){
    document.querySelectorAll('[data-cost-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.costView===view));
    document.querySelectorAll('#tab-cost .cost-view').forEach(el=>el.hidden=el.id!=='cost-view-'+view);
  }
  function row(category='general', label='', amount='', allocation=100) {
    const el=document.createElement('div');el.className='cost-overhead-row';
    el.innerHTML=`<label>หมวดค่าใช้จ่าย<select class="cost-category">${CATEGORIES.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label>
    <label>รายการ<input type="text" class="cost-label" maxlength="100" placeholder="ระบุค่าใช้จ่ายที่เกิดจริง"></label>
    <label>บาท/เดือน<input type="number" class="cost-amount" min="0" step="0.01" placeholder="0.00"></label>
    <label>สัดส่วนธุรกิจ (%)<input type="number" class="cost-allocation" min="0" max="100" step="1"></label>
    <button type="button" class="cost-overhead-remove" aria-label="ลบรายการค่าใช้จ่าย">ลบ</button>`;
    el.querySelector('.cost-category').value=category;
    el.querySelector('.cost-label').value=label;
    el.querySelector('.cost-amount').value=amount;
    el.querySelector('.cost-allocation').value=allocation;
    el.querySelector('button').addEventListener('click',()=>el.remove());
    $('costOverheadRows').appendChild(el);
  }
  function fillInitialForm(){
    $('costPeriod').value=new Date().toISOString().slice(0,7);
    row('facility');row('utilities');row('software');
    for(const [role,label] of ROLES){
      const node=document.createElement('label');node.textContent=label;
      const input=document.createElement('input');input.type='number';input.min='0.01';input.max='1000000';input.step='0.01';input.placeholder='บาทต่อชั่วโมง';
      input.className='cost-labor-rate';input.dataset.role=role;
      node.appendChild(input);$('costLaborRows').appendChild(node);
      const lab=document.createElement('label');lab.textContent=label;
      const hr=document.createElement('input');hr.type='number';hr.min='0';hr.step='0.25';hr.value='0';hr.dataset.role=role;
      hr.className='cost-sim-hour';lab.appendChild(hr);$('costSimLabor').appendChild(lab);
    }
  }
  function formProfile() {
    const overheads=[];
    for(const item of document.querySelectorAll('.cost-overhead-row')){
      const label=item.querySelector('.cost-label').value.trim();
      const amountValue=item.querySelector('.cost-amount').value.trim();
      if(!label&&!amountValue)continue;
      if(!label||amountValue==='')throw Error('กรอกชื่อและจำนวนเงินของค่าใช้จ่ายให้ครบ');
      const amount=E.amount(amountValue,'ค่าใช้จ่าย');
      const alloc=E.amount(item.querySelector('.cost-allocation').value,'สัดส่วนธุรกิจ');
      if(alloc>100)throw Error('สัดส่วนค่าใช้จ่ายต้องไม่เกิน 100%');
      overheads.push({category:item.querySelector('.cost-category').value,label,amount,allocation:alloc/100});
    }
    if(!overheads.length)throw Error('เพิ่มค่าใช้จ่ายส่วนกลางอย่างน้อยหนึ่งรายการ');
    const rates=[];
    for(const input of document.querySelectorAll('.cost-labor-rate')){
      const v=input.value.trim();if(!v)continue;
      const rate=E.amount(v,'ต้นทุนแรงงาน',false);rates.push({role:input.dataset.role,rate});
    }
    if(!rates.length)throw Error('เพิ่มค่าแรงอย่างน้อยหนึ่งประเภทงาน');
    const per=n('costPeriod');if(!/^\d{4}-\d{2}$/.test(per))throw Error('กรุณาเลือกเดือนที่เริ่มใช้');
    const profile={
      period_month:per+'-01',productive_hours:E.amount(parse('costProductiveHours'),'Productive Hours',false),
      overhead_lines:overheads,labor_rates:rates,
      b2c_margin:E.ratio(pct('costB2cMargin'),'B2C Margin'),
      b2b_margin:E.ratio(pct('costB2bMargin'),'B2B Margin'),
      b2c_payment_fee:E.ratio(pct('costB2cFee'),'B2C Fee'),
      b2b_payment_fee:E.ratio(pct('costB2bFee'),'B2B Fee'),
      b2b_admin_fee:E.amount(parse('costB2bAdmin'),'B2B Admin'),
      b2b_credit_days:E.amount(parse('costB2bDays'),'Credit Days'),
      b2b_financing_rate:E.ratio(pct('costFinance'),'Finance'),
      risk_pct:E.ratio(pct('costRisk'),'Risk'),notes:n('costNotes')
    };
    if(profile.productive_hours>744)throw Error('ชั่วโมงต่อเดือนเกิน 744');
    if(!Number.isInteger(profile.b2b_credit_days)||profile.b2b_credit_days>3650)throw Error('เครดิตเทอมต้องเป็นจำนวนวันเต็ม');
    if(profile.overhead_lines.length>40)throw Error('จำนวนรายการค่าใช้จ่ายเกิน 40');
    const o=E.overhead({productive_hours:profile.productive_hours,overheads:overheads});
    if(!Number.isFinite(o.monthly))throw Error('ต้นทุนส่วนกลางไม่ถูกต้อง');
    if((profile.b2c_margin+profile.b2c_payment_fee)>=.99||
      (profile.b2b_margin+profile.b2b_payment_fee+profile.b2b_financing_rate*profile.b2b_credit_days/365)>=.99)
      throw Error('Margin + Fee + Financing สูงเกินขอบเขต');
    if(profile.notes.length>1200)throw Error('หมายเหตุยาวเกิน 1,200 ตัวอักษร');
    return profile;
  }
  function fromRecord(r){return {
    productive_hours:Number(r.productive_hours),
    overheads:r.overhead_lines,
    labor_rates:Object.fromEntries((r.labor_rates||[]).map(x=>[x.role,Number(x.rate)])),
    b2c_margin:Number(r.b2c_margin),b2b_margin:Number(r.b2b_margin),
    b2c_payment_fee:Number(r.b2c_payment_fee),b2b_payment_fee:Number(r.b2b_payment_fee),
    b2b_admin_fee:Number(r.b2b_admin_fee),b2b_credit_days:Number(r.b2b_credit_days),
    b2b_financing_rate:Number(r.b2b_financing_rate),risk_pct:Number(r.risk_pct),
    status:r.status,period_month:r.period_month
  };}
  function snapshot(r){return { ...r, ...fromRecord(r) };}
  function editableFields(r){
    $('costPeriod').value=r.period_month.slice(0,7);$('costProductiveHours').value=r.productive_hours;
    const idMap={costB2cMargin:r.b2c_margin*100,costB2bMargin:r.b2b_margin*100,costB2cFee:r.b2c_payment_fee*100,costB2bFee:r.b2b_payment_fee*100,costB2bAdmin:r.b2b_admin_fee,costB2bDays:r.b2b_credit_days,costFinance:r.b2b_financing_rate*100,costRisk:r.risk_pct*100};
    for(const [id,val] of Object.entries(idMap)) $(id).value=Number(val).toFixed(id==='costB2bDays'?0:2);
    $('costNotes').value=r.notes||'';
    $('costOverheadRows').replaceChildren();
    for(const o of r.overheads)row(o.category,o.label,o.amount,o.allocation*100);
    for(const input of document.querySelectorAll('.cost-labor-rate'))input.value=r.labor_rates[input.dataset.role]??'';
  }
  function getSelected(){return profiles.find(p=>p.id===selectedId)||null;}
  function setSelected(id){selectedId=id;renderOverview();}
  function renderOverview(){
    const r=getSelected();
    const select=$('costProfileSelect');
    select.innerHTML='<option value="">ยังไม่มี Cost Profile</option>'+profiles.map(x=>`<option value="${esc(x.id)}">${esc(x.period_month.slice(0,7))} · ${esc(x.status.toUpperCase())} · ${esc(x.id.slice(0,8))}</option>`).join('');
    select.value=r?r.id:'';
    if(!r){$('costMonthly').textContent=$('costHourly').textContent=$('costHours').textContent='–';$('costStatus').textContent='ยังไม่มี';$('costBars').innerHTML='<p class="muted">เพิ่ม Cost Profile พร้อมหลักฐานอ้างอิงเพื่อเริ่มวิเคราะห์</p>';renderList();return;}
    const oh=E.overhead(r);$('costMonthly').textContent='฿'+formatMoney(oh.monthly);
    $('costHourly').textContent='฿'+formatMoney(oh.perHour);$('costHours').textContent=Number(r.productive_hours).toLocaleString('th-TH')+' ชม.';
    $('costStatus').textContent=({draft:'DRAFT',approved:'APPROVED',superseded:'SUPERSEDED'})[r.status]||r.status;
    const groups=new Map();for(const c of r.overheads)groups.set(c.category,(groups.get(c.category)||0)+Number(c.amount)*Number(c.allocation));
    $('costBars').innerHTML=[...groups].sort((a,b)=>b[1]-a[1]).map(([category,amount],i)=>{
      const label=CATEGORIES.find(c=>c[0]===category)?.[1]||category;return `<div><div class="cost-bar-head"><span>${esc(label)}</span><strong>฿${formatMoney(amount)}</strong></div><div class="cost-meter"><i class="${i===0?'accent':''}" style="width:${Math.max(1,Math.min(100,amount/oh.monthly*100))}%"></i></div></div>`;
    }).join('');renderList();
  }
  function renderList(){
    const member=current().member;
    $('costSnapshots').innerHTML=profiles.length?profiles.map(r=>`<div class="cost-snapshot"><div><strong>${esc(r.period_month.slice(0,7))} · ${esc(r.id.slice(0,8))}</strong><small>บันทึก ${esc(new Date(r.created_at).toLocaleDateString('th-TH'))} · ${esc(r.notes||'ไม่มีหมายเหตุ')}</small></div><div class="cost-snapshot-actions"><span class="cost-pill ${esc(r.status)}">${esc(r.status.toUpperCase())}</span><button class="cost-inline-link" type="button" data-cost-use="${esc(r.id)}">ดู/จำลอง</button>${member?.role==='owner'&&r.status==='draft'?`<button class="secondary" data-cost-approve="${esc(r.id)}" type="button">อนุมัติ</button>`:''}</div></div>`).join(''):'<p class="muted">ยังไม่มี Cost Profile ในฐานข้อมูล</p>';
    $('costSnapshots').querySelectorAll('[data-cost-use]').forEach(b=>b.addEventListener('click',()=>{setSelected(b.dataset.costUse);setView('simulator');notify('เลือก Cost Profile แล้ว · รายการสถานะ Draft ใช้ทดลองเท่านั้น');}));
    $('costSnapshots').querySelectorAll('[data-cost-approve]').forEach(b=>b.addEventListener('click',()=>{approvalId=b.dataset.costApprove;$('costApprovalPanel').hidden=false;$('costApprovalContext').textContent='Profile '+approvalId.slice(0,8)+' · การอนุมัติจะแทนที่ Profile ที่เคยอนุมัติในเดือนเดียวกัน (แต่เก็บประวัติไว้)';$('costApprovalReason').value='';$('costApprovalReason').focus();}));
  }
  async function load(){
    const {db,member}=current();if(!db||!member||loadBusy)return;
    loadBusy=true;notify('กำลังโหลดข้อมูลต้นทุนส่วนตัว...');
    try {
      const {data,error}=await db.from('scwork_cost_profiles').select('*').order('created_at',{ascending:false}).limit(100);
      if(error)throw error;
      profiles=(data||[]).map(snapshot);
      // The current period's approved record takes precedence over unapproved draft records.
      const pick=profiles.find(p=>p.id===selectedId) || profiles.filter(x=>x.status==='approved'&&x.period_month<=new Date().toISOString().slice(0,7)+'-01').sort((a,b)=>b.period_month.localeCompare(a.period_month))[0] || profiles[0];
      selectedId=pick?.id||'';renderOverview();loaded=true;notify(profiles.length?'โหลดข้อมูลเรียบร้อย':'ยังไม่มี Cost Profile: เริ่มที่แท็บ ตั้งค่าต้นทุน');
    }catch(e){
      profiles=[];selectedId='';renderOverview();
      notify('อ่าน Cost Management ไม่สำเร็จ: '+(e.message||e)+' · หากยังไม่ได้ติดตั้ง ให้รัน SQL 002_scwork_cost_management.sql หลังสำรองข้อมูลก่อน','error');
    }finally{loadBusy=false;}
  }
  function renderDraft(profile){
    const summary=E.overhead({productive_hours:profile.productive_hours,overheads:profile.overhead_lines});
    const el=$('costDraftPreview');el.hidden=false;
    el.innerHTML=`<span>ตัวอย่างการจัดสรร Overhead (ร่าง ยังไม่อนุมัติ)</span><strong>฿${formatMoney(summary.perHour)} / ชม.</strong><p>ค่าใช้จ่ายธุรกิจต่อเดือน ฿${formatMoney(summary.monthly)} ÷ ${Number(profile.productive_hours).toLocaleString('th-TH')} Productive Hours · ${profile.overhead_lines.length} รายการ · ${profile.labor_rates.length} อัตราค่าแรง</p>`;
  }
  async function save(e){
    e.preventDefault();const {db,member}=current();if(!db||!member||member.role==='viewer'){notify('ไม่มีสิทธิ์บันทึก Cost Profile');return;}
    let p;try{p=formProfile();renderDraft(p);}catch(err){notify(err.message,'error');return;}
    const button=$('costSaveProfile');button.disabled=true;notify('กำลังบันทึกร่างใน Supabase...');
    try{
      const args={p_period:p.period_month,p_hours:p.productive_hours,p_overheads:p.overhead_lines,p_labor:p.labor_rates,
        p_b2c_margin:p.b2c_margin,p_b2b_margin:p.b2b_margin,p_b2c_fee:p.b2c_payment_fee,p_b2b_fee:p.b2b_payment_fee,
        p_b2b_admin:p.b2b_admin_fee,p_credit_days:p.b2b_credit_days,p_finance:p.b2b_financing_rate,
        p_risk:p.risk_pct,p_notes:p.notes};
      const {data,error}=await db.rpc('scwork_create_cost_profile',args);if(error)throw error;
      await load();if(data){selectedId=data;renderOverview();}
      notify('บันทึก Draft สำเร็จ · ต้องให้ Owner อนุมัติก่อนใช้เป็นฐานต้นทุนภายใน');setView('overview');
    }catch(err){notify('บันทึกไม่สำเร็จ: '+(err.message||err),'error');}finally{button.disabled=false;}
  }
  async function approve(){
    const {db,member}=current();if(!approvalId||member?.role!=='owner'||!db){notify('สิทธิ์ไม่เพียงพอ');return;}
    const reason=$('costApprovalReason').value.trim();if(reason.length<8){notify('กรุณาระบุเหตุผลอนุมัติอย่างน้อย 8 ตัวอักษร');return;}
    $('costApproveConfirm').disabled=true;
    try{
      const {error}=await db.rpc('scwork_approve_cost_profile',{p_id:approvalId,p_reason:reason});if(error)throw error;
      approvalId='';$('costApprovalPanel').hidden=true;await load();notify('อนุมัติ Cost Profile แล้ว — ยังไม่เผยแพร่ราคาขาย');
    }catch(err){notify('อนุมัติไม่สำเร็จ: '+(err.message||err),'error');}finally{$('costApproveConfirm').disabled=false;}
  }
  function simulate(e){e.preventDefault();
    let profile=getSelected(), source='snapshot';
    if(!profile){try{profile=snapshot({...formProfile(),status:'draft'});source='unsaved-draft';}catch(err){notify('ยังไม่มี Cost Profile ที่คำนวณได้: '+err.message,'error');$('costSimResult').hidden=true;return;}}
    try {
      const details={
        supplier_total:parse('simSupplier'),extra_materials:parse('simExtra'),packaging:parse('simPacking'),
        outbound_freight:parse('simFreight'),machine_energy:parse('simEnergy'),outside_services:parse('simOutside'),
        activity_hours:parse('simActivityHours'),labor_hours:Object.fromEntries([...document.querySelectorAll('.cost-sim-hour')].map(input=>[input.dataset.role,input.value.trim()||'0']))
      };
      const result=E.quote(profile,details);
      const tr=(name,value)=>`<tr><td>${esc(name)}</td><td>฿${formatMoney(value)}</td></tr>`;
      const output=$('costSimResult');output.hidden=false;
      const note=source==='unsaved-draft'?'ร่างจากฟอร์ม ยังไม่ได้บันทึก':profile.status==='approved'?'ใช้ Cost Profile ที่อนุมัติภายในแล้ว (แต่ยังไม่ใช่ Approved Selling Rate)':profile.status==='superseded'?'Cost Profile เก่าที่ถูกแทนที่ ใช้ศึกษาเท่านั้น':'Cost Profile Draft ยังไม่ได้อนุมัติ';
      output.innerHTML=`<div class="cost-result-head"><strong>Cost Breakdown · INTERNAL SIMULATION</strong><p>${esc(note)}</p></div>
      <table class="cost-breakdown-table"><tbody>
      ${tr('ต้นทุนผลิต/วัสดุ/ขนส่ง/ค่าใช้จ่ายตรง (รวมสำรองของเสีย)',result.direct)}
      ${tr('Direct Labor ตามชั่วโมงที่กรอก',result.labor.total)}
      ${tr('Overhead ที่จัดสรรให้กิจกรรมงาน',result.allocatedOverhead)}
      ${tr('ต้นทุนก่อนค่าธรรมเนียมและต้นทุนเฉพาะผู้ซื้อ',result.commonCost)}</tbody></table>
      <div class="cost-price-grid">${[['b2c','B2C · บุคคลทั่วไป'],['b2b','B2B · นิติบุคคล']].map(([key,name])=>{
        const v=result.buyers[key];return `<div class="cost-price-card"><h3>${name}</h3><small class="cost-muted-note">เป้าหมาย Margin ${formatPercent(v.targetMargin)}</small><strong class="cost-price">฿${formatMoney(v.price)}</strong><p>กำไรหลังจัดสรร Overhead ฿${formatMoney(v.profit)}</p><span class="cost-price-margin">Margin จากสูตรจริง ${formatPercent(v.margin)}</span><p>Payment fee ฿${formatMoney(v.paymentFee)}${key==='b2b'?' · ต้นทุนเครดิต ฿'+formatMoney(v.financingCost):''}</p></div>`;
      }).join('')}</div><div class="cost-warning">ราคานี้เป็นผลจำลองภายใน ไม่ใช่ราคาขายอนุมัติ ไม่รวมกำไรจริงรายเดือนหรือผลภาษีเงินได้ · SCWork ยังไม่จด VAT จึงไม่เพิ่ม VAT ขาย · ภาษีหัก ณ ที่จ่าย (ถ้ามี) คือการรับเงินสุทธิ ไม่ใช่ส่วนลดราคาขาย</div>`;
      notify('คำนวณจาก '+note+' · ยังไม่ส่งราคาขึ้น Public Website');
    }catch(err){$('costSimResult').hidden=true;notify('คำนวณไม่ได้: '+err.message,'error');}
  }
  function init(){
    if(!$('tab-cost'))return;
    fillInitialForm();
    document.querySelectorAll('[data-cost-view]').forEach(btn=>btn.addEventListener('click',()=>setView(btn.dataset.costView)));
    document.querySelector('.tabs [data-tab="cost"]')?.addEventListener('click',()=>{if(!loaded)load();});
    window.addEventListener('scwork-admin-ready',()=>{const role=current().member?.role; $('costSaveProfile').disabled=role==='viewer'; $('costAddOverhead').disabled=role==='viewer'; loaded=false;load();});
    window.addEventListener('scwork-admin-signout',()=>{profiles=[];selectedId='';approvalId='';loaded=false;draftBuffer=null;$('costSimResult').hidden=true;$('costApprovalPanel').hidden=true;renderOverview();notify('');});
    $('costReload').addEventListener('click',load);
    $('costProfileSelect').addEventListener('change',e=>setSelected(e.target.value));
    $('costAddOverhead').addEventListener('click',()=>row());
    $('costProfileForm').addEventListener('submit',save);
    $('costLocalPreview').addEventListener('click',()=>{try{const p=formProfile();draftBuffer=p;renderDraft(p);notify('พรีวิวจากข้อมูลในฟอร์มเท่านั้น ยังไม่ได้บันทึก');}catch(err){notify(err.message,'error');}});
    $('costApproveConfirm').addEventListener('click',approve);
    $('costApproveCancel').addEventListener('click',()=>{approvalId='';$('costApprovalPanel').hidden=true;});
    $('costSimForm').addEventListener('submit',simulate);
    $('costSnapshots').addEventListener('dblclick',e=>{const b=e.target.closest('[data-cost-use]');if(b){const p=profiles.find(x=>x.id===b.dataset.costUse);if(p){editableFields(p);setView('master');notify('โหลดข้อมูลเก่าลงฟอร์มเพื่อสร้าง Snapshot ใหม่ ไม่แก้ไขข้อมูลเดิม');}}});
    // We do not fetch while signed out. Existing app.js is the sole authority for logged-in user/session.
    const {member}=current();if(member){$('costSaveProfile').disabled=member.role==='viewer';$('costAddOverhead').disabled=member.role==='viewer';load();}
  }
  init();
  window.SCWORK_COST_UI={engine:E,readSnapshot:()=>profiles.length,load};
})();
